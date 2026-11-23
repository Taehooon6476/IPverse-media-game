"""Local city-contract/security/packing checks; never AWS or gameplay evidence."""
import copy
import json
import math

import pytest

from server import gamespec, store, tools
from server.city_contract import CITY_SCHEMA, is_city_request
from server.tests.conftest import FakeS3, FakeTable, make_ctx
from server.tests.test_gamespec import authored_spec
from server.tests.test_tools import BUCKET, _add_ip, _glb, _session


def city_spec():
    spec = authored_spec()
    spec["title"] = "도시 코어 운송"
    spec["objective"] = {"type": "talk", "target": 1, "label": "안내인에게 임무 받기"}
    spec["world"] = {
        "width": 600, "depth": 600, "spawn": {"x": -12, "z": 232},
        "entities": [{"id": "delivery_gate", "kind": "beacon", "x": 188, "z": -12}],
        "propPlacements": [{"id": "core", "propIndex": 0, "x": -12, "z": 0, "stageId": "pickup"}],
        "enemySpawns": [],
        "npc": {"id": "guide", "propIndex": 1, "x": -12, "z": 220, "name": "카이"},
        "city": {
            "districts": [
                {"id": "center", "name": "다운타운", "style": "downtown",
                 "x": 0, "z": 0, "width": 200, "depth": 400},
                {"id": "homes", "name": "주택가", "style": "residential",
                 "x": -200, "z": 0, "width": 180, "depth": 500},
                {"id": "harbor", "name": "항구", "style": "waterfront",
                 "x": 200, "z": 0, "width": 180, "depth": 500},
            ],
            "streets": [
                {"id": f"road_{axis}_{index}", "axis": axis, "coordinate": coordinate, "width": 16}
                for axis in ("x", "z") for index, coordinate in enumerate((-180, 0, 180))
            ],
            "vehicles": [{"id": "quest_car", "kind": "sedan", "x": 0, "z": 208, "yaw": 0}],
            "pedestrians": [
                {"id": "walker_a", "propIndex": 1, "x": -12, "z": 40,
                 "route": [{"x": -12, "z": 40}, {"x": -12, "z": 100}]},
                {"id": "walker_b", "propIndex": 1, "x": 168, "z": -80,
                 "route": [{"x": 168, "z": -80}, {"x": 168, "z": -40}]},
            ],
        },
    }
    spec["mission"]["stages"] = [
        {"id": "briefing", "type": "talk", "label": "안내인에게 임무 받기", "target": 1,
         "entityIds": ["guide"], "propIndex": 1},
        {"id": "transport", "type": "drive", "label": "지정 차량을 140m 운전", "target": 1,
         "entityIds": ["quest_car"], "distanceMeters": 140},
        {"id": "pickup", "type": "collect", "label": "중앙 도로의 코어 회수", "target": 1,
         "entityIds": ["core"], "propIndex": 0},
        {"id": "deliver", "type": "reach", "label": "항구 인도로 코어 운송", "target": 1,
         "entityIds": ["delivery_gate"]},
    ]
    return spec


def invalid(spec, fragment):
    validated, errors = gamespec.validate_spec(spec)
    assert validated is None, errors
    assert any(fragment in error for error in errors), errors


def test_city_preserves_large_layout_exact_ip_roles_stage_distance_and_input():
    raw = city_spec()
    before = copy.deepcopy(raw)
    result, errors = gamespec.validate_spec(raw)
    assert errors == []
    assert raw == before
    assert result["world"]["width"] == result["world"]["depth"] == 600
    assert [s["type"] for s in result["mission"]["stages"]] == ["talk", "drive", "collect", "reach"]
    assert result["mission"]["stages"][1]["entityIds"] == ["quest_car"]
    assert result["mission"]["stages"][1]["distanceMeters"] == 140
    assert result["world"]["city"]["trafficCount"] == 0
    assert result["world"]["city"]["seed"] == 1234
    assert result["world"]["city"]["vehicles"][0]["color"] == result["palette"]["accent"]
    assert all(p["propIndex"] == result["world"]["npc"]["propIndex"] == 1
               for p in result["world"]["city"]["pedestrians"])


def test_1200m_city_reachability_is_bounded_without_truncating_far_targets():
    raw = city_spec()
    raw["world"].update(width=1200, depth=1200)
    raw["world"]["entities"][0].update(x=550, z=-12)
    result, errors = gamespec.validate_spec(raw)
    assert errors == []
    assert result["world"]["entities"][0]["x"] == 550


@pytest.mark.parametrize("size", [36, 100, 299, 1201, True, float("nan"), float("inf")])
def test_city_cannot_silently_shrink_or_accept_unbounded_world(size):
    raw = city_spec()
    raw["world"]["width"] = size
    invalid(raw, "world.width")


def test_existing_noncity_world_bounds_and_stage_types_remain_strict():
    raw = authored_spec()
    result, errors = gamespec.validate_spec(raw)
    assert errors == [] and result["world"]["width"] == 48
    raw["world"]["width"] = 300
    invalid(raw, "36-100")
    raw = authored_spec()
    raw["mission"]["stages"][0].update(type="drive", target=1, distanceMeters=100)
    invalid(raw, "drive requires world.city")
    raw = authored_spec()
    raw["objective"] = {"type": "drive", "target": 1}
    invalid(raw, "objective.type")


@pytest.mark.parametrize("field,value,fragment", [
    ("style", "gta6", "style"), ("style", [], "style"),
    ("width", 79, "width"), ("depth", 601, "depth"), ("x", 299, "fit entirely"),
    ("x", float("nan"), "world bounds"), ("width", True, "width"),
    ("modelUrl", "https://foreign.invalid/city.glb", "unsupported fields"),
])
def test_district_geometry_and_closed_schema(field, value, fragment):
    raw = city_spec()
    raw["world"]["city"]["districts"][0][field] = value
    invalid(raw, fragment)


@pytest.mark.parametrize("field,value,fragment", [
    ("axis", "y", "axis"), ("axis", [], "axis"), ("width", 25, "width"),
    ("coordinate", 280, "world bounds"), ("coordinate", True, "world bounds"),
    ("coordinate", float("inf"), "world bounds"),
])
def test_roads_have_valid_axes_width_and_edge_clearance(field, value, fragment):
    raw = city_spec()
    raw["world"]["city"]["streets"][0][field] = value
    invalid(raw, fragment)


def test_connected_global_grid_requires_both_axes_and_distinct_parallel_roads():
    raw = city_spec()
    raw["world"]["city"]["streets"] = raw["world"]["city"]["streets"][:3] + [
        {"id": "only_z", "axis": "z", "coordinate": 0, "width": 16}
    ]
    invalid(raw, "at least two z-axis roads")
    raw = city_spec()
    raw["world"]["city"]["streets"][1]["coordinate"] = -175
    invalid(raw, "non-overlapping")


@pytest.mark.parametrize("field,value,fragment", [
    ("kind", "jet", "kind"), ("yaw", math.pi + .01, "yaw"), ("yaw", True, "yaw"),
    ("x", 70, "connected road"), ("z", 600, "world bounds"),
    ("color", "red", "hex color"), ("assetKey", "../../owned.glb", "unsupported fields"),
])
def test_vehicles_are_bounded_data_on_actual_roads(field, value, fragment):
    raw = city_spec()
    raw["world"]["city"]["vehicles"][0][field] = value
    invalid(raw, fragment)


def test_city_pedestrians_use_selected_npc_not_a_prop_or_procedural_substitute():
    raw = city_spec()
    raw["world"]["city"]["pedestrians"][0]["propIndex"] = 0
    invalid(raw, "actual selected NPC slot")
    raw = city_spec()
    del raw["world"]["npc"]
    invalid(raw, "actual selected NPC")
    raw = city_spec()
    del raw["world"]["npc"]["propIndex"]
    invalid(raw, "actual selected NPC")


@pytest.mark.parametrize("route,fragment", [
    ([{"x": -12, "z": 40}], "2-8 points"),
    ([{"x": -12, "z": 40}] * 2, "distinct waypoints"),
    ([{"x": -12, "z": 40}, {"x": 70, "z": 70}], "follow connected roads"),
    ([{"x": -12, "z": 40}, {"x": -12, "z": 600}], "world bounds"),
    ([{"x": -12, "z": 40}, {"x": -12, "z": 100, "script": "run()"}], "unsupported fields"),
])
def test_walk_routes_are_bounded_reachable_and_not_ignored(route, fragment):
    raw = city_spec()
    raw["world"]["city"]["pedestrians"][0]["route"] = route
    invalid(raw, fragment)


def test_city_and_authored_ids_share_one_namespace():
    for target in ("districts", "streets", "vehicles", "pedestrians"):
        raw = city_spec()
        raw["world"]["city"][target][0]["id"] = "guide"
        invalid(raw, "unique across")


@pytest.mark.parametrize("field,value,fragment", [
    ("target", 2, "target must be 1"), ("entityIds", [], "exactly one"),
    ("entityIds", ["quest_car", "walker_a"], "exactly one"),
    ("entityIds", ["unknown_car"], "unknown world entity"),
    ("entityIds", ["guide"], "stage action type"),
    ("distanceMeters", 19, "20-1500"), ("distanceMeters", 1501, "20-1500"),
    ("distanceMeters", True, "20-1500"), ("distanceMeters", float("nan"), "20-1500"),
    ("holdSec", 1, "ignored"), ("propIndex", 1, "ignored"), ("enemyIndex", 0, "ignored"),
])
def test_drive_requires_exact_vehicle_actual_distance_contract(field, value, fragment):
    raw = city_spec()
    raw["mission"]["stages"][1][field] = value
    invalid(raw, fragment)


def test_drive_distance_is_required_and_cannot_be_ignored_by_other_stage_types():
    raw = city_spec()
    del raw["mission"]["stages"][1]["distanceMeters"]
    invalid(raw, "distanceMeters")
    raw = city_spec()
    raw["mission"]["stages"][0]["distanceMeters"] = 50
    invalid(raw, "only used by drive")
    raw = city_spec()
    raw["objective"] = {"type": "drive", "target": 1}
    assert gamespec.validate_spec(raw)[1] == []
    raw["objective"]["target"] = 2
    invalid(raw, "objective.drive target")


def test_actual_pedestrian_ids_are_valid_talk_targets_for_the_same_npc_ip():
    raw = city_spec()
    raw["mission"]["stages"][0]["entityIds"] = ["walker_a"]
    result, errors = gamespec.validate_spec(raw)
    assert errors == []
    assert result["mission"]["stages"][0]["propIndex"] == 1
    assert result["mission"]["stages"][0]["entityIds"] == ["walker_a"]


def test_city_spawn_targets_and_solid_landmarks_cannot_block_or_leave_roads():
    raw = city_spec()
    raw["world"]["spawn"] = {"x": 70, "z": 70}
    invalid(raw, "spawn must be on a road")
    raw = city_spec()
    raw["world"]["entities"][0].update(x=70, z=70)
    invalid(raw, "mission target delivery_gate")
    raw = city_spec()
    raw["world"]["entities"].append(
        {"id": "road_wall", "kind": "box", "x": 0, "z": 100,
         "width": 10, "depth": 10, "height": 5})
    invalid(raw, "must not block a city road")
    raw = city_spec()
    raw["world"]["entities"].append(
        {"id": "sidewalk_wall", "kind": "box", "x": -14, "z": 70,
         "width": 5, "depth": 4, "height": 4})
    invalid(raw, "route overlaps solid geometry")


@pytest.mark.parametrize("field,value", [
    ("eval", "run()"), ("assetUrl", "https://foreign.invalid/model.glb"),
    ("trafficCount", 17), ("trafficCount", True), ("seed", -1),
])
def test_city_unknown_or_out_of_range_fields_fail_clearly(field, value):
    raw = city_spec()
    raw["world"]["city"][field] = value
    invalid(raw, "world.city")

def test_authored_environment_cannot_silently_ignore_external_scene_options():
    raw = city_spec()
    raw["environment"] = {"modelUrl": "https://foreign.invalid/world.glb"}
    invalid(raw, "environment contains unsupported fields")


def setup_owned_assets():
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    session = _session(ctx)
    for name in (*tools.RUNTIME3D_FILES, *tools.CITY_RUNTIME_FILES):
        ctx.s3._store[(BUCKET, tools.RUNTIME3D_PREFIX + name)] = f"runtime:{name}".encode()
    for ip_id in ("ip_hero", "ip_core", "ip_mentor"):
        _add_ip(ctx, session["sessionId"], ip_id, f"own:{ip_id}".encode())
    store.update_ip(ctx, session["sessionId"], "ip_core", kind="prop")
    _glb(ctx, session["sessionId"], "ip_mentor", body=b"local-contract-only-npc-bytes")
    _glb(ctx, session["sessionId"], "ip_hero", body=b"own-hero-model")  # a 3D game needs its player in 3D
    return ctx, session


def test_make_game_packs_city_runtime_and_owned_ip_without_model_paths_or_mesh_zip():
    ctx, session = setup_owned_assets()
    raw = city_spec()
    raw["player"]["ipId"] = "ip_hero"
    raw["props"][1]["modelUrl"] = "https://foreign.invalid/npc.glb"
    design = {"prompt": "선택 IP로 600m 도시, 차량 운전과 코어 운송",
              "castIpIds": ["ip_hero", "ip_core", "ip_mentor"], "playerIpId": "ip_hero",
              "propIpIds": ["ip_core"], "enemyIpIds": [], "npcIpIds": ["ip_mentor"]}
    result = tools.make_game(ctx, session, {"spec": raw, "_game_design": design})
    assert "error" not in result, result
    prefix = f"games/{result['gameId']}/"
    saved = json.loads(ctx.s3._store[(BUCKET, prefix + "spec.json")])
    assert saved["design"]["sourcePrompt"] == design["prompt"]
    assert saved["world"]["city"]["pedestrians"][0]["propIndex"] == saved["world"]["npc"]["propIndex"]
    assert saved["props"][1]["modelUrl"] == "assets/ip_mentor.glb"
    assert ctx.s3._store[(BUCKET, prefix + "assets/ip_mentor.glb")] == b"local-contract-only-npc-bytes"
    assert ctx.s3._store[(BUCKET, prefix + "assets/ip_mentor.png")] == b"own:ip_mentor"
    for name in (*tools.RUNTIME3D_FILES, *tools.CITY_RUNTIME_FILES):
        assert ctx.s3._store[(BUCKET, prefix + name)] == f"runtime:{name}".encode()
    assert "foreign.invalid" not in json.dumps(saved)
    assert not any("city-assets/" in call["CopySource"]["Key"] for call in ctx.s3.copies)


@pytest.mark.parametrize("source", ["GTA6 스타일 오픈월드", "build a city with vehicles",
                                   "도시 차량 게임", "urban streets", "open-world transport"])
def test_explicit_city_requests_cannot_be_replaced_by_a_mini_arena(source):
    ctx, session = setup_owned_assets()
    before = dict(ctx.s3._store)
    raw = authored_spec()
    raw["player"]["ipId"] = "ip_hero"
    result = tools.make_game(ctx, session, {"spec": raw, "_source_prompt": source})
    assert result["error"] == "city_world_required"
    assert ctx.s3._store == before
    assert ctx.s3.copies == []
    assert store.snapshot(ctx, session["sessionId"])["games"] == []


def test_city_npc_must_be_a_prepared_character_ip_not_an_item():
    ctx, session = setup_owned_assets()
    store.update_ip(ctx, session["sessionId"], "ip_mentor", kind="prop")
    raw = city_spec()
    raw["player"]["ipId"] = "ip_hero"
    out = tools.make_game(ctx, session, {"spec": raw})
    assert out["error"] == "invalid_city_npc_ip"
    assert ctx.s3.copies == []

def test_city_packs_same_selected_npc_rig_and_animation_library_while_core_stays_raw():
    """Local labeled bytes verify role-safe packing, not actual skeletal playback."""
    ctx, session = setup_owned_assets()
    sid = session["sessionId"]
    _glb(ctx, sid, "ip_mentor", "rigged_glb", "riggedGlbAssetId", b"selected-npc-own-rig")
    _glb(ctx, sid, "ip_core", body=b"selected-core-own-raw")
    _glb(ctx, sid, "ip_core", "rigged_glb", "riggedGlbAssetId", b"unused-core-rig")
    ctx.s3._store[(BUCKET, tools.RUNTIME3D_PREFIX + "anims/ual.glb")] = b"local-library-contract"
    raw = city_spec()
    raw["player"]["ipId"] = "ip_hero"
    out = tools.make_game(ctx, session, {"spec": raw})
    assert "error" not in out, out
    prefix = f"games/{out['gameId']}/"
    saved = json.loads(ctx.s3._store[(BUCKET, prefix + "spec.json")])
    assert saved["props"][saved["world"]["npc"]["propIndex"]]["modelUrl"] == "assets/ip_mentor.rig.glb"
    assert all(saved["props"][p["propIndex"]]["modelUrl"] == "assets/ip_mentor.rig.glb"
               for p in saved["world"]["city"]["pedestrians"])
    assert saved["props"][0]["modelUrl"] == "assets/ip_core.glb"
    assert saved["animUrl"] == "assets/ual.glb"
    assert ctx.s3._store[(BUCKET, prefix + "assets/ip_mentor.rig.glb")] == b"selected-npc-own-rig"
    assert ctx.s3._store[(BUCKET, prefix + "assets/ip_core.glb")] == b"selected-core-own-raw"
    assert ctx.s3._store[(BUCKET, prefix + "assets/ual.glb")] == b"local-library-contract"
    assert (BUCKET, prefix + "assets/ip_core.rig.glb") not in ctx.s3._store


def test_pedestrian_prop_reference_alone_selects_a_prepared_humanoid_rig_in_resolver():
    """Isolate the resolver role path; publication still requires a valid guide."""
    raw = city_spec()
    del raw["world"]["npc"]
    out = gamespec.resolve_sprites(raw, {"ip_mentor": {"kind": "character"}},
                                  {"ip_mentor"}, {"ip_mentor"})
    assert out["props"][1]["modelUrl"] == "assets/ip_mentor.rig.glb"
    assert out["animUrl"] == "assets/ual.glb"


def test_exported_tool_schema_contains_closed_city_and_drive_contract():
    schema = tools._GAMESPEC["properties"]
    assert schema["world"]["properties"]["city"] == CITY_SCHEMA
    assert CITY_SCHEMA["additionalProperties"] is False
    assert CITY_SCHEMA["properties"]["vehicles"]["minItems"] == 1
    assert CITY_SCHEMA["properties"]["districts"]["maxItems"] == 6
    stage = schema["mission"]["properties"]["stages"]["items"]["properties"]
    assert "drive" in stage["type"]["enum"]
    assert stage["distanceMeters"]["maximum"] == 1500
    assert "drive" in schema["objective"]["properties"]["type"]["enum"]
    assert "city-contract.js" in tools.RUNTIME3D_FILES
    assert set(tools.CITY_RUNTIME_FILES) == {"city.js", "city-controller.js", "city-layout.js", "race.js", "carrig.js"}
    assert not is_city_request("도시락을 들고 숲에서 코어 탐험")


def city_with_ip_car(**entity):
    raw = city_spec()
    car = raw["world"]["city"]["vehicles"][0]
    raw["world"]["entities"].append({"id": "ray_car", "kind": "model", "ipId": "ip_car", "car": "player",
                                     "x": car["x"], "z": car["z"], **entity})
    car["modelId"] = "ray_car"
    return raw


def test_city_vehicle_can_drive_as_the_selected_ip_car_model():
    result, errors = gamespec.validate_spec(city_with_ip_car())
    assert errors == []
    assert result["world"]["city"]["vehicles"][0]["modelId"] == "ray_car"
    body = next(e for e in result["world"]["entities"] if e["id"] == "ray_car")
    assert body["solid"] is False  # a car body, not a static set piece on the road


@pytest.mark.parametrize("model_id", ["missing_car", "delivery_gate", 7, ""], ids=["unknown", "beacon", "number", "empty"])
def test_city_vehicle_model_must_name_a_car_body_entity(model_id):
    raw = city_with_ip_car()
    raw["world"]["city"]["vehicles"][0]["modelId"] = model_id
    invalid(raw, "modelId")
    raw = city_with_ip_car()
    del next(e for e in raw["world"]["entities"] if e["id"] == "ray_car")["car"]
    invalid(raw, "modelId")


def test_city_takes_the_selected_background_image_as_its_sky():
    raw = city_spec()
    raw["world"]["background"] = {"ipId": "ip_neon", "mode": "image"}
    result, errors = gamespec.validate_spec(raw)
    assert errors == [] and result["world"]["background"]["mode"] == "image"


def test_make_game_packs_the_ip_car_glb_for_a_city_vehicle():
    ctx, session = setup_owned_assets()
    _add_ip(ctx, session["sessionId"], "ip_car", b"own:ip_car")
    store.update_ip(ctx, session["sessionId"], "ip_car", kind="prop")
    _glb(ctx, session["sessionId"], "ip_car", body=b"selected-car-own-raw")
    raw = city_with_ip_car()
    raw["player"]["ipId"] = "ip_hero"
    out = tools.make_game(ctx, session, {"spec": raw})
    assert "error" not in out, out
    prefix = f"games/{out['gameId']}/"
    saved = json.loads(ctx.s3._store[(BUCKET, prefix + "spec.json")])
    body = next(e for e in saved["world"]["entities"] if e["id"] == "ray_car")
    assert body["modelUrl"] == "assets/ip_car.set.glb" and saved["world"]["city"]["vehicles"][0]["modelId"] == "ray_car"
    assert ctx.s3._store[(BUCKET, prefix + "assets/ip_car.set.glb")] == b"selected-car-own-raw"


def test_a_photoreal_biome_line_is_not_a_city_request():
    from server.city_contract import is_city_request
    assert not is_city_request("게임 요청: 디아블로 같은 핵앤슬래시\n실사 환경: 폐허 도시 [ruins]")
    assert not is_city_request("게임 요청: 밤거리 결투\n실사 환경: 네온 야경 [night-city]")
    assert is_city_request("GTA 같은 오픈월드 도시 게임")
    assert is_city_request("실사 환경: 숲 [forest]\n게임 요청: 도시를 누비는 레이싱")
