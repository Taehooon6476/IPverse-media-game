from server.gamespec import resolve_sprites, validate_spec
import copy
import math
import pytest


def minimal_sf():
    return {
        "version": 1,
        "genre": "sf-shooter",
        "palette": {"bg": "#0b0d12", "accent": "#5de6cf", "text": "#f5f7fa"},
        "player": {"ipId": "ip_1", "name": "루나", "speed": 2},
        "enemies": [{"name": "드론", "color": "#ff5a5a", "shape": "triangle", "speed": 2, "hp": 1}],
        "objective": {"type": "kills", "target": 15},
        "difficulty": "normal",
    }


def test_validate_spec_accepts_minimal_sf():
    raw = minimal_sf()
    raw["player"]["speed"] = 2.0  # integral floats are normalized
    spec, errors = validate_spec(raw)
    assert errors == []
    assert spec["player"]["speed"] == 2 and type(spec["player"]["speed"]) is int
    assert spec["props"] == [] and spec["dialogue"] == [] and spec["quest"] is None
    assert "map" not in spec  # map defaults are for rpg only
    assert raw["player"]["speed"] == 2.0 and "props" not in raw  # input untouched


def test_validate_spec_fills_rpg_defaults():
    spec = minimal_sf()
    spec.update(genre="rpg-explore", objective={"type": "collect", "target": 3})
    del spec["enemies"]
    spec, errors = validate_spec(spec)
    assert errors == []
    assert spec["enemies"] == [] and spec["map"] == {"width": 20, "height": 15, "seed": 1234}


def test_validate_spec_rejects_rpg_objective_for_sf():
    spec = minimal_sf()
    spec["objective"] = {"type": "talk", "target": 3}
    out, errors = validate_spec(spec)
    assert out is None
    assert errors == ["objective.type must be kills|survive|boss|collect|reach for sf-shooter"]
    spec["engine"] = "phaser"  # the 2D runtime keeps its two SF objectives
    assert validate_spec(spec)[1] == ["objective.type must be kills|survive for sf-shooter"]


def test_validate_spec_accepts_3d_environment_rules_and_mission_label():
    spec = minimal_sf()
    spec.update(objective={"type": "reach", "target": 4, "label": "통신탑 4곳을 점령하라"},
                environment={"theme": "ice-station", "sky": "storm", "layout": "ring", "size": 40, "obstacles": 6},
                rules={"timeLimitSec": 240, "enemyRate": 0.5, "playerHp": 200})
    out, errors = validate_spec(spec)
    assert errors == [] and out["environment"]["theme"] == "ice-station"
    spec["environment"] = {"size": 99}
    assert validate_spec(spec)[1] == ["environment.size must be an integer 18-45"]


def test_validate_spec_rejects_bad_hex():
    spec = minimal_sf()
    spec["palette"]["accent"] = "#5de6c"
    spec["enemies"][0]["color"] = "#ff5a5a\n"  # no trailing-newline loophole
    out, errors = validate_spec(spec)
    assert out is None
    assert errors == [
        "palette.accent must be a #rrggbb hex color",
        "enemies[0].color must be a #rrggbb hex color",
    ]


def test_validate_spec_rejects_bools_and_long_dialogue():
    spec = minimal_sf()
    spec["version"] = True
    spec["dialogue"] = [{"speaker": "루나", "text": "가" * 141}]
    _, errors = validate_spec(spec)
    assert errors == ["version must be 1", "dialogue[0].text must be a string of at most 140 characters"]
    assert validate_spec(["not", "an", "object"]) == (None, ["spec must be a JSON object"])


def test_resolve_sprites_sets_relative_urls():
    spec, _ = validate_spec(minimal_sf())
    spec["props"] = [
        {"ipId": "ip_2", "name": "코어", "effect": "score"},
        {"ipId": "ip_ghost", "name": "없음", "effect": "key", "spriteUrl": "https://evil.example/x.png"},
    ]
    out = resolve_sprites(spec, {"ip_1": {}, "ip_2": {}})
    assert out["player"]["spriteUrl"] == "assets/ip_1.png"
    assert out["props"][0]["spriteUrl"] == "assets/ip_2.png"
    assert "spriteUrl" not in out["props"][1]  # unknown ip → runtime placeholder, never a model URL
    assert "spriteUrl" not in spec["player"]  # pure


def test_validate_spec_3d_fields_mirror_js():
    spec = minimal_sf()
    assert validate_spec({**spec, "engine": "three"})[1] == []
    assert validate_spec({**spec, "engine": None})[1] == []
    assert validate_spec({**spec, "engine": "unity"})[1] == ["engine must be phaser|three"]
    spec["player"]["modelUrl"] = ""
    spec["props"] = [{"ipId": "ip_2", "effect": "heal", "modelUrl": 3}]
    assert validate_spec(spec)[1] == ["player.modelUrl must be a non-empty string", "props[0].modelUrl must be a non-empty string"]
    spec["player"]["modelUrl"] = "assets/ip_1.glb"
    spec["props"][0]["modelUrl"] = None
    assert validate_spec(spec)[1] == []


def test_resolve_sprites_sets_model_urls_only_for_glb_ips():
    spec, _ = validate_spec(minimal_sf())
    spec["player"]["modelUrl"] = "https://evil.example/x.glb"
    spec["props"] = [{"ipId": "ip_2", "name": "코어", "effect": "score", "modelUrl": "x.glb"}]
    out = resolve_sprites(spec, {"ip_1": {}, "ip_2": {}}, {"ip_1"})
    assert out["player"]["modelUrl"] == "assets/ip_1.glb"
    assert "modelUrl" not in out["props"][0] and out["props"][0]["spriteUrl"] == "assets/ip_2.png"
    assert "modelUrl" not in resolve_sprites(spec, {"ip_1": {}})["player"]  # default: no models (Phaser)


def test_validate_spec_animated_3d_fields():
    from server.gamespec import validate_spec
    spec = minimal_sf()
    spec.update(animUrl="assets/ual.glb")
    spec["player"].update(modelUrl="assets/ip_1.rig.glb", weaponUrl="assets/ip_w.glb", weaponType="gun")
    spec["enemies"][0].update(ipId="ip_2", modelUrl="assets/ip_2.rig.glb", weaponUrl="assets/ip_w.glb", humanoid=True)
    assert validate_spec(spec)[1] == []
    for path, value, field in ((("animUrl",), "", "animUrl"), (("player", "weaponUrl"), 3, "player.weaponUrl"),
                               (("player", "weaponType"), "bow", "player.weaponType"),
                               (("enemies", 0, "modelUrl"), "", "enemies[0].modelUrl"),
                               (("enemies", 0, "weaponUrl"), False, "enemies[0].weaponUrl"),
                               (("enemies", 0, "humanoid"), "yes", "enemies[0].humanoid")):
        bad = minimal_sf()
        target = bad
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
        _, errors = validate_spec(bad)
        assert any(field in e for e in errors), (field, errors)


def authored_spec():
    """Local design fixture: contract proof only, never model/runtime proof."""
    spec = minimal_sf()
    spec.update(version=2, engine="three", title="두 구역의 코어 탐험",
                enemies=[], objective={"type": "collect", "target": 2},
                props=[{"ipId": "ip_core", "name": "코어", "effect": "key"},
                       {"ipId": "ip_mentor", "name": "안내인", "effect": "score"}],
                world={
                    "width": 48, "depth": 48, "groundColor": "#223344",
                    "spawn": {"x": -18, "z": 15},
                    "entities": [
                        {"id": "divider", "kind": "box", "x": 0, "z": 0,
                         "width": .5, "depth": 10, "height": 3, "solid": True},
                        {"id": "exit", "kind": "beacon", "x": 15, "z": -15},
                    ],
                    "propPlacements": [
                        {"id": "core_a", "propIndex": 0, "x": -12, "z": 2, "stageId": "find"},
                        {"id": "core_b", "propIndex": 0, "x": 12, "z": 3, "stageId": "find"},
                    ],
                    "enemySpawns": [],
                    "npc": {"id": "mentor", "propIndex": 1, "x": 16, "z": -10, "name": "안내인"},
                },
                mission={"title": "코어 회수와 탈출", "stages": [
                    {"id": "find", "type": "collect", "label": "양쪽 구역의 코어 두 개 회수",
                     "target": 2, "entityIds": ["core_a", "core_b"], "propIndex": 0},
                    {"id": "report", "type": "talk", "label": "안내인에게 회수 결과 보고",
                     "target": 1, "entityIds": ["mentor"], "propIndex": 1},
                    {"id": "leave", "type": "reach", "label": "출구 비콘까지 이동",
                     "target": 1, "entityIds": ["exit"], "holdSec": 1},
                ], "successText": "코어를 회수하고 탈출했습니다."},
                mechanics={"autoFire": False, "jump": False, "dash": True, "regenPerSec": 0},
                artDirection={"skyColor": "#778899", "fogColor": "#334455", "fogDensity": .02,
                              "exposure": 1.2, "bloomStrength": .5})
    return spec


def assert_invalid(spec, fragment):
    result, errors = validate_spec(spec)
    assert result is None, errors
    assert any(fragment in error for error in errors), errors


def test_authored_v2_retains_real_positions_role_indices_stage_order_and_art():
    raw = authored_spec()
    before = copy.deepcopy(raw)
    result, errors = validate_spec(raw)
    assert errors == [], errors
    assert raw == before
    assert result["world"]["spawn"] == {"x": -18, "z": 15}
    assert result["world"]["propPlacements"][1]["propIndex"] == 0
    assert result["world"]["npc"]["propIndex"] == 1
    assert [stage["type"] for stage in result["mission"]["stages"]] == ["collect", "talk", "reach"]
    assert result["mission"]["stages"][0]["entityIds"] == ["core_a", "core_b"]
    assert result["artDirection"] == before["artDirection"]
    assert result["mechanics"]["jump"] is False
    assert result["world"]["entities"][1]["solid"] is False


def test_peaceful_sf_v2_never_requires_an_unselected_enemy_but_v1_still_does():
    raw = minimal_sf()
    raw["enemies"] = []
    assert_invalid(raw, "enemies must be an array of 1-5")
    normalized, errors = validate_spec(authored_spec())
    assert errors == [] and normalized["enemies"] == []


@pytest.mark.parametrize("engine", [None, "phaser", "unreal"])
def test_authored_v2_cannot_silently_fall_back_to_old_engine(engine):
    raw = authored_spec()
    raw["engine"] = engine
    assert_invalid(raw, "engine")


@pytest.mark.parametrize("section", ["world", "mission"])
def test_authored_v2_missing_design_sections_fail(section):
    raw = authored_spec()
    del raw[section]
    assert_invalid(raw, section)


def test_authored_worlds_change_structure_and_actions_not_just_mission_wording():
    first = authored_spec()
    second = authored_spec()
    second["world"]["entities"][0].update(x=-5, z=-5, rotation=math.pi / 3,
                                         width=12, depth=.5, color="#665544")
    second["world"]["spawn"] = {"x": -18, "z": -18}
    second["world"]["propPlacements"][0].update(x=-15, z=10)
    second["mission"]["stages"] = [
        {"id": "wait", "type": "survive", "label": "신호 동기화 5초 대기", "target": 5},
        *second["mission"]["stages"],
    ]
    a, ea = validate_spec(first)
    b, eb = validate_spec(second)
    assert ea == eb == [], (ea, eb)
    assert a["world"]["spawn"] != b["world"]["spawn"]
    assert a["world"]["entities"] != b["world"]["entities"]
    assert a["mission"]["stages"][0]["type"] != b["mission"]["stages"][0]["type"]


def test_authored_missing_selected_prop_or_enemy_placement_is_rejected():
    raw = authored_spec()
    raw["world"]["npc"].pop("propIndex")
    assert_invalid(raw, "props[1] must be placed")
    raw = authored_spec()
    raw["enemies"] = [{"ipId": "ip_enemy", "color": "#ff0000",
                       "shape": "circle", "hp": 2, "speed": 1}]
    assert_invalid(raw, "enemies[0] must have an actual enemy spawn")


def test_authored_role_index_and_stage_target_must_match_exact_ip_slot():
    raw = authored_spec()
    raw["world"]["propPlacements"][0]["propIndex"] = 100
    assert_invalid(raw, "existing template index")
    raw = authored_spec()
    raw["mission"]["stages"][0]["propIndex"] = 1
    assert_invalid(raw, "exact propIndex")


def test_authored_future_collectibles_activate_at_first_matching_stage():
    raw = authored_spec()
    for placement in raw["world"]["propPlacements"]:
        del placement["stageId"]
    result, errors = validate_spec(raw)
    assert errors == []
    assert [placement["stageId"] for placement in result["world"]["propPlacements"]] == ["find", "find"]
    # A later stage cannot demand already-consumed instances.
    raw["mission"]["stages"].append({
        "id": "repeat", "type": "collect", "label": "같은 코어를 다시 수집",
        "target": 1, "entityIds": ["core_a"],
    })
    assert_invalid(raw, "consumed or belongs to a different stage")


def test_authored_unknown_duplicate_wrong_kind_and_impossible_targets_fail():
    raw = authored_spec()
    raw["mission"]["stages"][0]["entityIds"] = ["foreign_entity"]
    assert_invalid(raw, "unknown world entity")
    raw = authored_spec()
    raw["mission"]["stages"][0]["entityIds"] = ["core_a", "core_a"]
    assert_invalid(raw, "duplicate targets")
    raw = authored_spec()
    raw["mission"]["stages"][0]["entityIds"] = ["exit"]
    assert_invalid(raw, "stage action type")
    raw = authored_spec()
    raw["mission"]["stages"][0]["target"] = 3
    assert_invalid(raw, "exceeds the actual eligible")


def test_authored_spawn_actor_and_required_beacon_do_not_overlap_solid_walls():
    raw = authored_spec()
    raw["world"]["spawn"] = {"x": 0, "z": 0}
    assert_invalid(raw, "spawn overlaps solid")
    raw = authored_spec()
    raw["world"]["propPlacements"][0].update(x=0, z=1)
    assert_invalid(raw, "overlaps solid geometry")
    raw = authored_spec()
    raw["world"]["entities"][1].update(x=0, z=1)
    assert_invalid(raw, "beacon overlaps solid geometry")


def test_authored_rotated_geometry_and_actor_positions_fit_world_bounds():
    raw = authored_spec()
    raw["world"]["entities"][0].update(x=20, z=20, width=12, depth=12, rotation=math.pi / 4)
    assert_invalid(raw, "rotated geometry must fit")
    raw = authored_spec()
    raw["world"]["propPlacements"][0]["x"] = -24
    assert_invalid(raw, "must stay within world bounds")


def test_authored_sealed_required_targets_are_rejected_by_bounded_ground_check():
    raw = authored_spec()
    raw["world"]["entities"] = [
        {"id": f"wall_{index}", "kind": "box", "x": 0, "z": z,
         "width": 1, "depth": 12, "height": 3}
        for index, z in enumerate([-18, -6, 6, 18])
    ] + [raw["world"]["entities"][1]]
    assert_invalid(raw, "unreachable through the authored ground layout")


@pytest.mark.parametrize("field,value", [
    ("kind", []), ("x", float("nan")), ("x", float("inf")), ("x", True),
    ("width", -1), ("height", 99), ("rotation", 8), ("solid", "yes"), ("emissive", 5),
])
def test_authored_invalid_geometry_is_validation_error_not_crash(field, value):
    raw = authored_spec()
    raw["world"]["entities"][0][field] = value
    assert_invalid(raw, "world.entities")


@pytest.mark.parametrize("field,value", [
    ("target", True), ("target", 201), ("type", []), ("propIndex", -1),
    ("entityIds", [{"id": "core_a"}]), ("holdSec", -1),
])
def test_authored_invalid_stage_is_validation_error_not_crash(field, value):
    raw = authored_spec()
    raw["mission"]["stages"][0][field] = value
    assert_invalid(raw, "mission.stages")


@pytest.mark.parametrize("section,field,value", [
    ("world", "script", "arbitrary()"),
    ("mechanics", "eval", "arbitrary()"),
    ("artDirection", "textureUrl", "https://foreign.invalid/image.png"),
])
def test_authored_new_sections_never_accept_arbitrary_code_urls_or_ignored_fields(section, field, value):
    raw = authored_spec()
    raw[section][field] = value
    assert_invalid(raw, "unsupported fields")


def test_authored_enemy_cutouts_are_resolved_from_owned_ip_not_model_url():
    raw = authored_spec()
    raw["enemies"] = [{"ipId": "ip_enemy", "color": "#ff0000", "shape": "circle",
                       "speed": 1, "hp": 2, "spriteUrl": "https://foreign.invalid/image.png"}]
    raw["world"]["enemySpawns"] = [
        {"id": "guard", "enemyIndex": 0, "x": -15, "z": -12, "stageId": "fight"}]
    raw["mission"]["stages"].insert(0, {
        "id": "fight", "type": "kills", "label": "선택한 적을 격파",
        "target": 1, "entityIds": ["guard"], "enemyIndex": 0,
    })
    spec, errors = validate_spec(raw)
    assert errors == [], errors
    out = resolve_sprites(spec, {"ip_1": {}, "ip_core": {}, "ip_mentor": {}, "ip_enemy": {}})
    assert out["enemies"][0]["spriteUrl"] == "assets/ip_enemy.png"
    assert "modelUrl" not in out["enemies"][0]
    assert out["world"]["enemySpawns"][0]["enemyIndex"] == 0
    assert raw["enemies"][0]["spriteUrl"].startswith("https://foreign.invalid")


def test_authored_boss_count_is_one_enemy_not_an_invented_hp_target():
    raw = authored_spec()
    raw["enemies"] = [{"ipId": "ip_enemy", "color": "#ff0000", "shape": "circle", "speed": 1, "hp": 3}]
    raw["world"]["enemySpawns"] = [{"id": "boss_actor", "enemyIndex": 0, "x": -15, "z": -12}]
    raw["mission"]["stages"].append({
        "id": "boss_stage", "type": "boss", "label": "보스를 격파", "target": 30,
        "entityIds": ["boss_actor"],
    })
    assert_invalid(raw, "boss target must be 1")


def test_authored_guide_prefers_available_rig_and_adds_library_without_rigged_player():
    raw = authored_spec()
    before = copy.deepcopy(raw)
    ips = {"ip_1": {"kind": "character"}, "ip_core": {"kind": "prop"},
           "ip_mentor": {"kind": "character"}}
    result = resolve_sprites(raw, ips, set(ips), {"ip_mentor", "ip_core"})
    assert result["player"]["modelUrl"] == "assets/ip_1.glb"
    assert result["props"][0]["modelUrl"] == "assets/ip_core.glb"
    assert result["props"][1]["modelUrl"] == "assets/ip_mentor.rig.glb"
    assert result["animUrl"] == "assets/ual.glb"
    assert raw == before


@pytest.mark.parametrize("kind,humanoid,expected", [
    ("character", True, "assets/ip_mentor.rig.glb"),
    ("enemy", True, "assets/ip_mentor.rig.glb"),
    ("enemy", False, "assets/ip_mentor.glb"),
    ("prop", True, "assets/ip_mentor.glb"),
])
def test_authored_npc_rig_selection_respects_actual_ip_kind(kind, humanoid, expected):
    raw = authored_spec()
    result = resolve_sprites(raw, {"ip_mentor": {"kind": kind, "humanoid": humanoid}},
                             {"ip_mentor"}, {"ip_mentor"})
    assert result["props"][1]["modelUrl"] == expected
    assert ("animUrl" in result) == expected.endswith(".rig.glb")


def test_guide_without_a_prepared_rig_keeps_actual_raw_model_and_v1_props_do_not_change():
    raw = authored_spec()
    ips = {"ip_mentor": {"kind": "character"}}
    result = resolve_sprites(raw, ips, {"ip_mentor"}, set())
    assert result["props"][1]["modelUrl"] == "assets/ip_mentor.glb"
    assert "animUrl" not in result
    raw["version"] = 1  # resolver compatibility only, not a valid v1 world contract
    result = resolve_sprites(raw, ips, {"ip_mentor"}, {"ip_mentor"})
    assert result["props"][1]["modelUrl"] == "assets/ip_mentor.glb"
    assert "animUrl" not in result
