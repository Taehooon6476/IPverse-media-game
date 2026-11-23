"""Genre modules in the authored contract: race stages (city), moving entities, coin pickups, fall respawn, crypt."""
import math

from server import gamespec
from server.tests.test_city_contract import city_spec, invalid
from server.tests.test_gamespec import authored_spec


def race_spec(**stage):
    spec = city_spec()
    gates = [("cp_a", 0, 180), ("cp_b", 180, 0), ("cp_c", 0, -180), ("cp_d", -180, 0)]
    spec["world"]["entities"] += [{"id": i, "kind": "beacon", "x": x, "z": z, "width": 8} for i, x, z in gates]
    spec["mission"]["stages"].append({"id": "race", "type": "race", "label": "3랩 레이스", "target": 3,
                                      "entityIds": [g[0] for g in gates], "vehicleId": "quest_car", "rivals": 3, **stage})
    return spec


def test_race_counts_laps_over_ordered_checkpoint_beacons():
    validated, errors = gamespec.validate_spec(race_spec())
    assert errors == [] and validated["mission"]["stages"][-1]["target"] == 3  # laps, not a beacon count


def test_race_bounds():
    invalid(race_spec(target=6), "lap count")
    invalid(race_spec(rivals=9), "rivals")
    invalid(race_spec(vehicleId="nope"), "vehicleId")
    spec = race_spec()
    spec["mission"]["stages"][-1]["entityIds"] = ["cp_a", "cp_b"]
    invalid(spec, "3-16 ordered checkpoint")
    spec = race_spec()
    spec["mission"]["stages"][-1]["entityIds"] = ["cp_a", "cp_b", "guide"]
    invalid(spec, "targets must match")
    spec = authored_spec()
    spec["mission"]["stages"][2]["rivals"] = 2
    invalid(spec, "only used by race")


def platformer_spec():
    spec = authored_spec()
    spec["world"]["entities"] += [
        {"id": "lift", "kind": "platform", "x": -10, "z": -10, "y": 1, "height": .4, "width": 3, "depth": 3,
         "motion": {"axis": "y", "distance": 3, "periodSec": 5}},
        {"id": "coin_1", "kind": "crystal", "x": -14, "z": 8, "y": 1, "pickup": True},
        {"id": "coin_2", "kind": "crystal", "x": -6, "z": 8, "pickup": True},
    ]
    spec["mission"]["stages"].insert(0, {"id": "coins", "type": "reach", "label": "코인 2개", "target": 2,
                                         "entityIds": ["coin_1", "coin_2"]})
    spec["mechanics"]["fallRespawn"] = True
    spec["artDirection"]["biome"] = "crypt"
    return spec


def test_moving_platform_coins_fall_respawn_and_crypt_validate():
    validated, errors = gamespec.validate_spec(platformer_spec())
    assert errors == []
    coin = next(e for e in validated["world"]["entities"] if e["id"] == "coin_1")
    assert coin["solid"] is False  # a pickup never blocks
    assert validated["mechanics"]["fallRespawn"] is True and validated["artDirection"]["biome"] == "crypt"


def test_motion_and_pickup_bounds():
    spec = platformer_spec()
    spec["world"]["entities"][-3]["motion"]["distance"] = 40
    invalid(spec, "motion.distance")
    spec = platformer_spec()
    spec["world"]["entities"][0]["motion"] = {"axis": "x", "distance": 2}  # the divider is a box: allowed
    assert gamespec.validate_spec(spec)[1] == []
    spec["world"]["entities"][1]["motion"] = {"axis": "x", "distance": 2}  # a beacon cannot move
    invalid(spec, "motion is only for")
    spec = platformer_spec()
    spec["world"]["entities"][1]["pickup"] = True  # a beacon is not a coin
    invalid(spec, "pickup must be true and only for")


def stair_spec():
    """A platformer whose collectibles are authored on the open floor beside the climb."""
    spec = authored_spec()
    spec["world"]["entities"] = [
        {"id": "s1", "kind": "platform", "x": -16, "z": -16, "y": .6, "width": 4, "depth": 4, "height": .6},
        {"id": "s2", "kind": "platform", "x": -10, "z": -16, "y": 1.4, "width": 4, "depth": 4, "height": .6},
        {"id": "s3", "kind": "platform", "x": -4, "z": -16, "y": 2.2, "width": 4, "depth": 4, "height": .6,
         "rotation": .5},
        {"id": "ride", "kind": "platform", "x": 2, "z": -16, "y": 3, "width": 4, "depth": 4, "height": .6,
         "motion": {"axis": "x", "distance": 2}},
        {"id": "flag", "kind": "beacon", "x": 2, "z": -16, "y": 3},
        {"id": "coin_floor", "kind": "crystal", "x": 9, "z": 9, "pickup": True},
        {"id": "coin_under", "kind": "crystal", "x": -4, "z": -16, "pickup": True},
    ]
    spec["world"]["propPlacements"] = [
        {"id": "core_a", "propIndex": 0, "x": -15, "z": -11, "stageId": "find"},  # on the floor beside s1
        {"id": "core_b", "propIndex": 0, "x": -10, "z": -16, "stageId": "find"},  # authored over s2 (a low top)
    ]
    spec["mission"]["stages"].insert(1, {"id": "coins", "type": "reach", "label": "코인 2개", "target": 2,
                                         "entityIds": ["coin_floor", "coin_under"]})
    spec["mission"]["stages"][-1]["entityIds"] = ["flag"]
    spec["mechanics"].update(jump=True, fallRespawn=True)
    return spec


def seat_of(validated, item):
    """The highest platform whose rotated footprint holds the item, like authored.js platformUnder."""
    def holds(e):
        c, s, dx, dz = math.cos(e["rotation"]), math.sin(e["rotation"]), item["x"] - e["x"], item["z"] - e["z"]
        return abs(dx * c - dz * s) <= e["width"] / 2 and abs(dx * s + dz * c) <= e["depth"] / 2
    tops = [e for e in validated["world"]["entities"] if e["kind"] == "platform" and holds(e)]
    return max(tops, key=lambda e: e["y"] + e["height"], default=None)


def test_platformer_collectibles_are_seated_on_the_climb_not_the_floor():
    validated, errors = gamespec.validate_spec(stair_spec())
    assert errors == [], errors  # a placement over a low platform is on it, not "overlapping solid geometry"
    placements = {p["id"]: p for p in validated["world"]["propPlacements"]}
    assert seat_of(validated, placements["core_a"])["id"] == "s1"  # off the floor onto the nearest free top
    assert (placements["core_b"]["x"], placements["core_b"]["z"]) == (-10, -16)  # already over s2: untouched
    coins = {e["id"]: e for e in validated["world"]["entities"] if e.get("pickup")}
    for coin in coins.values():
        seat = seat_of(validated, coin)
        assert seat is not None and coin["y"] == seat["y"], coin  # at the platform's level: the runtime lifts it on top
    assert seat_of(validated, coins["coin_floor"])["id"] == "ride"  # spread along the climb, rides the mover
    assert coins["coin_under"]["y"] == 2.2  # a floor coin under s3 goes up to s3, not below it


def test_a_support_under_a_platform_never_blocks_the_collectible_on_its_top():
    """A post holding up s1 must not make the prop seated on s1 "overlap solid geometry" (a floor prop is re-seated
    onto the same platform, so the agent could not move it away); the same for a prop authored over s2."""
    spec = stair_spec()
    spec["world"]["entities"] += [
        {"id": "post_1", "kind": "box", "x": -16, "z": -16, "width": 2, "depth": 2, "height": .6},  # up to s1's bottom
        {"id": "post_2", "kind": "box", "x": -10, "z": -16, "width": 2, "depth": 2, "height": 1.8},  # into s2 (1.4–2.0)
    ]
    for fall_respawn in (False, True):
        spec["mechanics"]["fallRespawn"] = fall_respawn
        validated, errors = gamespec.validate_spec(spec)
        assert errors == [], (fall_respawn, errors)
    placements = {p["id"]: p for p in validated["world"]["propPlacements"]}
    assert [seat_of(validated, placements[p])["id"] for p in ("core_a", "core_b")] == ["s1", "s2"]

    spec["world"]["entities"][-2]["height"] = 1.6  # now it pokes through s1's top (1.2): the prop would be inside it
    invalid(spec, "world.propPlacements[0] overlaps solid geometry")


def test_floor_collectibles_stay_where_authored_outside_a_platformer():
    spec = stair_spec()
    spec["mechanics"]["fallRespawn"] = False
    validated, errors = gamespec.validate_spec(spec)
    assert errors == [], errors
    assert validated["world"]["propPlacements"][0] == spec["world"]["propPlacements"][0]
    assert next(e for e in validated["world"]["entities"] if e["id"] == "coin_floor")["y"] == 0


def test_enemy_tiers_use_distinct_enemy_ips_when_there_are_and_offer_variants_when_not():
    """Enemy tiers that share the session's one enemy IP are said so; variants are offered, not made unasked (they
    would delay the game a whole 3D chain)."""
    from server import prompts
    lines = prompts.SYSTEM.splitlines()
    arpg = next(line for line in lines if "핵앤슬래시(style arpg)" in line)
    assert "종류마다 서로 다른 적 IP" in arpg
    rule = next(line for line in lines if line.startswith("- 적 등급 IP"))
    for must in ("돌려 쓰고", "알린다", "reference_ip_id", "create_ip_asset(kind enemy", "사용자가 원할 때만", "render_3d"):
        assert must in rule, must
    # an explicit cast still wins: no IP the user did not pick
    assert "[출연 IP cast_ip_ids=…]" in rule and "새 IP를 넣지 않는다" in rule


def test_the_rules_describe_the_runtime_fair_play_numbers():
    """What the agent tells players about restarts, auto-fire and wave ends is what game3d/arpg-data.js does."""
    import pathlib
    import re
    from server import prompts
    data = (pathlib.Path(__file__).parents[2] / "game3d" / "arpg-data.js").read_text()
    value = lambda name: re.search(rf"export const {name} = ([\d.]+);", data)[1]  # noqa: E731
    assert f"다시 시작하면 {value('RESUME_GRACE_SEC')}초간 무적" in prompts.SYSTEM
    assert f"적은 {value('RESUME_CLEARANCE')}m 밖에서 나온다" in prompts.SYSTEM
    assert f"간격 {value('AUTO_FIRE_SLOW')}배" in prompts.SYSTEM
    assert "survive·boss 단계가 끝나면 남은 적은 공격을 멈추고 물러나" in prompts.SYSTEM
