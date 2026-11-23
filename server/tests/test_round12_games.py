"""Sky islands are artDirection.setting "sky" (game3d/sky.js): no floor, a cloud sea far below, a fall that respawns,
and a climb that starts from the ground islands with the platformer's step limits (test_round11_games.py)."""
import copy
import math
from pathlib import Path

import pytest

from server import authored_contract as ac, gamespec, prompts
from server.tests.test_genre_modules import stair_spec
from server.tests.test_round9_games import art
from server.tests.test_round11_games import climb, gap, rumi, top


@pytest.mark.parametrize("prompt", ["구름 위 하늘섬을 건너는 우편 배달", "공중섬 탐험 플랫포머", "하늘 섬 사이를 점프",
                                    "떠 있는 섬들 위의 보물", "부유섬 레이스 코스", "a floating island platformer",
                                    "sky islands adventure", "castles above the clouds", "구름섬 건너기"])
def test_sky_words_make_sky_islands(prompt):
    assert art(prompt, biome="temple").get("setting") == "sky"


@pytest.mark.parametrize("prompt, given", [
    ("하늘색 원피스를 입은 기사의 숲 모험", {"biome": "forest"}),  # 하늘색 is a colour
    ("구름 위로 솟은 설산 등반", {"biome": "snow"}),  # a mountain above the clouds still has a floor
    ("하늘섬 지하 감옥 탈출", {"biome": "crypt"}),  # indoors: walls and a floor
    ("하늘 신전의 비밀 항로", {"biome": "temple"}),  # 하늘 alone is not an island
    ("city skyline rooftop chase", {"biome": "night-city"}),
    ("섬유 공장 잠입", {"biome": "industrial"}),
])
def test_no_sky_islands_without_them(prompt, given):
    assert art(prompt, **given).get("setting") != "sky"


def test_the_agent_set_setting_stays():
    assert art("하늘섬 항구", biome="night-city", setting="harbor")["setting"] == "harbor"
    assert art("구름 위 하늘섬 항구", biome="temple")["setting"] == "sky"  # an airship dock in the sky, not the sea


def test_rumis_sky_island_game_becomes_a_sky_world_from_its_own_title():
    """A remake's request may name no place; the game's own title does."""
    validated, errors = gamespec.validate_spec(rumi())
    assert errors == [], errors
    assert "setting" not in validated["artDirection"]
    gamespec.apply_setting(validated, validated["design"]["sourcePrompt"])
    assert validated["artDirection"]["setting"] == "sky"
    assert validated["mechanics"]["fallRespawn"] is True and validated["mechanics"]["jump"] is True
    # its climb already starts within a jump of the start island
    islands = ac.sky_islands(validated["world"])
    assert [i["id"] for i in islands] == ["home"]
    first = next(e for e in validated["world"]["entities"] if e["id"] == "plat_start")
    assert top(first) <= ac.STEP_RISE and gap(islands[0], first) <= ac.STEP_GAP
    again, errors = gamespec.validate_spec(copy.deepcopy(validated))  # the published spec validates as it is
    assert errors == [], errors and again["artDirection"]["setting"] == "sky"


def unreachable_from(validated, islands, rise=ac.STEP_RISE, span=ac.STEP_GAP):
    """Platforms no chain of steps reaches from the ground islands (top y = 0); no floor between them."""
    platforms = [e for e in validated["world"]["entities"] if e["kind"] == "platform"]
    reached, left = list(islands), list(platforms)
    while True:
        ok = [p for p in left if any(top(p) - top(s) <= rise + 1e-6 and gap(s, p) <= span + 1e-6 for s in reached)]
        if not ok:
            return [p["id"] for p in left]
        reached += ok
        left = [p for p in left if p not in ok]


def test_a_sky_climb_starts_from_the_start_island_not_the_floor():
    """On a floor, the first step 30 m away is walked to. In the sky that is a 30 m drop: stepping stones lead to it
    from the start island, each within the step limits."""
    spec = climb()
    spec["world"]["spawn"] = {"x": -44, "z": 30}  # 26 m from the first step, over the clouds
    spec["artDirection"] = {"biome": "temple", "setting": "sky"}
    validated, errors = gamespec.validate_spec(spec)
    assert errors == [], errors
    islands = ac.sky_islands(validated["world"])
    assert unreachable_from(validated, islands) == []
    stones = [e for e in validated["world"]["entities"] if e["id"].startswith("step_")]
    assert stones and all(top(s) <= ac.STEP_RISE for s in stones)
    assert validated["mechanics"]["fallRespawn"] is True
    # on a floor the same world needs no stones: the floor is a source everywhere
    floor = climb()
    floor["world"]["spawn"] = {"x": -44, "z": 30}
    on_floor, errors = gamespec.validate_spec(floor)
    assert not errors and not [e for e in on_floor["world"]["entities"] if e["id"].startswith("step_")]


def test_whatever_stands_on_the_floor_gets_a_ground_island():
    world = {"spawn": {"x": 0, "z": 0}, "entities": [
        {"id": "p", "kind": "platform", "x": 10, "z": 0, "y": 0, "width": 4, "depth": 4, "height": 1, "rotation": 0},
        {"id": "tower", "kind": "building", "x": -20, "z": 5, "width": 3, "depth": 5, "height": 6},
        {"id": "flag", "kind": "beacon", "x": 10, "z": 0, "y": 1}],  # on the platform: no island
        "enemySpawns": [{"id": "e1", "enemyIndex": 0, "x": 20, "z": 20}], "npc": {"x": -5, "z": -5},
        "propPlacements": [{"id": "gem", "propIndex": 0, "x": 10.5, "z": .5}, {"id": "far", "propIndex": 0, "x": 30, "z": 0}]}
    islands = {i["id"]: i for i in ac.sky_islands(world)}
    assert set(islands) == {"home", "tower", "e1", "npc", "far"}
    assert islands["home"]["width"] == ac.SKY_HOME and islands["tower"]["width"] == 5 + 2 * ac.SKY_PAD
    assert islands["e1"]["width"] == ac.SKY_SPOT and all(i["y"] == 0 and i["height"] == 0 for i in islands.values())


def test_the_runtime_builds_the_same_ground_islands():
    """game3d/sky.js mirrors SKY_HOME, SKY_PAD and SKY_SPOT."""
    src = Path(__file__).resolve().parents[2] / "game3d" / "sky.js"
    text = src.read_text()
    for key, value in (("home", ac.SKY_HOME), ("pad", ac.SKY_PAD), ("spot", ac.SKY_SPOT)):
        assert f"{key}: {value:g}," in text, key
    assert "'sky'" in (src.parent / "authored-contract.js").read_text()


def test_the_contract_accepts_sky_and_still_refuses_an_unknown_setting():
    spec = stair_spec()
    spec["artDirection"] = {"biome": "temple", "setting": "sky"}
    validated, errors = gamespec.validate_spec(spec)
    assert errors == [], errors
    assert validated["artDirection"]["setting"] == "sky" and validated["mechanics"]["fallRespawn"] is True
    assert "sky" in ac.SETTINGS and ac.AUTHORED_PROPERTIES["artDirection"]["properties"]["setting"]["enum"] == list(ac.SETTINGS)


def test_the_game_rules_describe_the_sky_setting():
    line = [line for line in prompts.SYSTEM.splitlines() if "구름 바다" in line]
    assert line and "하늘섬" in line[0] and "떨어지면" in line[0]


def test_reachability_between_islands_uses_the_round11_limits():
    platforms = [{"id": "a", "kind": "platform", "x": 7, "z": 0, "y": 0, "width": 4, "depth": 4, "height": 1.6, "rotation": 0}]
    home = ac.sky_islands({"spawn": {"x": 0, "z": 0}, "entities": platforms})
    changes = ac.connect_climb(platforms, home)
    assert changes == ["a: 0.40 m lower"] and top(platforms[0]) == pytest.approx(ac.STEP_RISE)
    assert math.isclose(gap(home[0], platforms[0]), 1.0)


def test_a_remake_with_no_request_text_still_reads_the_sky_from_the_title():
    """A remake with no source prompt: the title names the sky."""
    from server import gamespec
    spec = {"version": 2, "title": "루미의 하늘섬 우편 배달", "world": {"width": 80, "depth": 80, "entities": []},
            "artDirection": {"biome": "temple"}, "mission": {"title": "하늘섬 배달", "stages": []}}
    assert gamespec.apply_setting(spec, None)["artDirection"].get("setting") == "sky"
