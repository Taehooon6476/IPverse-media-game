"""Data-only city extension for authored v2 games; no external URLs or code."""
from __future__ import annotations

import math
import re

STYLES = ("downtown", "residential", "industrial", "waterfront")
VEHICLES = ("sedan", "suv", "taxi")
_ID = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,47}")
_HEX = re.compile(r"#[0-9a-fA-F]{6}")
_CITY_REQUEST = re.compile(
    r"도시(?!락)|시가지|도심|오픈\s*월드|다운타운|"
    r"\b(?:city|urban|open[- ]world|gta(?:\s*\d)?|grand theft auto)\b", re.I)


def _obj(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required),
            "additionalProperties": False}


def _num(lo, hi):
    return {"type": "number", "minimum": lo, "maximum": hi}


ID = {"type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,47}$", "maxLength": 48}
POINT = _obj({"x": _num(-600, 600), "z": _num(-600, 600)}, ("x", "z"))
POSITION = {"id": ID, "x": _num(-600, 600), "z": _num(-600, 600)}
CITY_SCHEMA = _obj({
    "districts": {"type": "array", "minItems": 3, "maxItems": 6, "items": _obj({
        **POSITION, "name": {"type": "string", "minLength": 1, "maxLength": 100},
        "style": {"type": "string", "enum": list(STYLES)},
        "width": _num(80, 600), "depth": _num(80, 600),
    }, ("id", "name", "style", "x", "z", "width", "depth"))},
    "streets": {"type": "array", "minItems": 4, "maxItems": 14, "items": _obj({
        "id": ID, "axis": {"type": "string", "enum": ["x", "z"]},
        "coordinate": _num(-600, 600), "width": _num(8, 24),
    }, ("id", "axis", "coordinate", "width"))},
    "vehicles": {"type": "array", "minItems": 1, "maxItems": 8, "items": _obj({
        **POSITION, "kind": {"type": "string", "enum": list(VEHICLES)},
        "yaw": _num(-math.pi, math.pi), "color": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"},
        # the selected IP car as this vehicle's body: a world.entities {kind: "model", ipId, car} id
        "modelId": ID,
    }, ("id", "kind", "x", "z", "yaw"))},
    "pedestrians": {"type": "array", "minItems": 1, "maxItems": 8, "items": _obj({
        **POSITION, "propIndex": {"type": "integer", "minimum": 0, "maximum": 23},
        "route": {"type": "array", "minItems": 2, "maxItems": 8, "items": POINT},
    }, ("id", "propIndex", "x", "z", "route"))},
    "trafficCount": {"type": "integer", "minimum": 0, "maximum": 16},
    "seed": {"type": "integer", "minimum": 0, "maximum": 2147483647},
}, ("districts", "streets", "vehicles", "pedestrians"))


# A photoreal biome choice, or "not a city" itself (Korean or English), is not a city request
_NOT_A_CITY = re.compile(r"^\s*(?:실사 환경|Photoreal (?:environment|biome)|Environment):.*$|\bnight-city\b"
                         r"|도시(?:가|는)?\s*아닌|비도시|도시\s*밖|도시\s*외곽\s*(?:아닌|말고)"
                         r"|\b(?:not|no|non)[\s-]+(?:a\s+|an\s+|in\s+a\s+)?(?:city|urban)\b|\boutside\s+(?:of\s+)?(?:the|a)\s+city\b",
                         re.M | re.I)


def is_city_request(text):
    return isinstance(text, str) and _CITY_REQUEST.search(_NOT_A_CITY.sub("", text)) is not None


def number(value, lo, hi):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and lo <= value <= hi and math.isfinite(value))


def integer(value, lo, hi):
    return number(value, lo, hi) and int(value) == value


def near_street(point, streets, margin=8):
    """Roads span the world: x roads have constant z, z roads constant x."""
    return any(abs(point["z" if road["axis"] == "x" else "x"] - road["coordinate"])
               <= road["width"] / 2 + margin for road in streets)


def _walkable_segment(a, b, streets):
    if abs(a["x"] - b["x"]) < .001 and abs(a["z"] - b["z"]) < .001:
        return near_street(a, streets)
    if abs(a["z"] - b["z"]) < .001:
        return any(r["axis"] == "x" and abs(a["z"] - r["coordinate"]) <= r["width"] / 2 + 8
                   for r in streets)
    if abs(a["x"] - b["x"]) < .001:
        return any(r["axis"] == "z" and abs(a["x"] - r["coordinate"]) <= r["width"] / 2 + 8
                   for r in streets)
    return False


def validate_city(spec, errors, existing_ids=()):
    """Normalize a deepcopied city; return entities for the shared mission index."""
    world = spec["world"]
    city = world.get("city")
    seen = set(existing_ids)
    half_w, half_d = world["width"] / 2, world["depth"] / 2

    def need(ok, message):
        if not ok:
            errors.append(message)
        return bool(ok)

    def obj(value, path, schema):
        if not need(isinstance(value, dict), f"{path} must be an object"):
            return False
        need(not set(value) - set(schema["properties"]), f"{path} contains unsupported fields")
        return True

    def identity(item, path):
        value = item.get("id")
        if not need(isinstance(value, str) and _ID.fullmatch(value) is not None,
                    f"{path}.id must be a bounded identifier"):
            return False
        if not need(value not in seen, f"{path}.id must be unique across the world and city"):
            return False
        seen.add(value)
        return True

    def point(value, path):
        if not obj(value, path, POINT):
            return False
        return need(number(value.get("x"), -half_w + 1, half_w - 1)
                    and number(value.get("z"), -half_d + 1, half_d - 1),
                    f"{path} must remain within city world bounds")

    def position(item, path):
        return need(number(item.get("x"), -half_w + 1, half_w - 1)
                    and number(item.get("z"), -half_d + 1, half_d - 1),
                    f"{path} must remain within city world bounds")

    def array(name):
        rule = CITY_SCHEMA["properties"][name]
        value = city.get(name)
        if not need(isinstance(value, list) and rule["minItems"] <= len(value) <= rule["maxItems"],
                    f"world.city.{name} must contain {rule['minItems']}-{rule['maxItems']} items"):
            return []
        return value

    if not obj(city, "world.city", CITY_SCHEMA):
        return None
    city.setdefault("trafficCount", 0)
    city.setdefault("seed", 1234)
    for key, maximum in (("trafficCount", 16), ("seed", 2147483647)):
        if need(integer(city[key], 0, maximum), f"world.city.{key} must be an integer 0-{maximum}"):
            city[key] = int(city[key])

    districts = array("districts")
    for i, district in enumerate(districts):
        path = f"world.city.districts[{i}]"
        if not obj(district, path, CITY_SCHEMA["properties"]["districts"]["items"]):
            continue
        identity(district, path)
        name = district.get("name")
        need(isinstance(name, str) and 1 <= len(name.strip()) <= 100, f"{path}.name must be 1-100 characters")
        need(isinstance(district.get("style"), str) and district["style"] in STYLES,
             f"{path}.style must be {'|'.join(STYLES)}")
        valid = position(district, path)
        for key in ("width", "depth"):
            valid &= need(number(district.get(key), 80, 600), f"{path}.{key} must be a number 80-600")
        if valid:
            need(abs(district["x"]) + district["width"] / 2 <= half_w
                 and abs(district["z"]) + district["depth"] / 2 <= half_d,
                 f"{path} must fit entirely within world bounds")

    streets = array("streets")
    valid_streets = []
    for i, road in enumerate(streets):
        path = f"world.city.streets[{i}]"
        if not obj(road, path, CITY_SCHEMA["properties"]["streets"]["items"]):
            continue
        identity(road, path)
        axis = road.get("axis")
        valid = need(isinstance(axis, str) and axis in ("x", "z"), f"{path}.axis must be x|z")
        valid &= need(number(road.get("width"), 8, 24), f"{path}.width must be a number 8-24")
        if not valid:
            continue
        half = half_d if axis == "x" else half_w
        if need(number(road.get("coordinate"), -half + road["width"] / 2 + 16,
                       half - road["width"] / 2 - 16),
                f"{path} must fit within world bounds"):
            valid_streets.append(road)
    for axis in ("x", "z"):
        parallel = sorted((road for road in valid_streets if road["axis"] == axis), key=lambda r: r["coordinate"])
        need(len(parallel) >= 2, f"world.city.streets requires at least two {axis}-axis roads")
        for a, b in zip(parallel, parallel[1:]):
            need(b["coordinate"] - a["coordinate"] > (a["width"] + b["width"]) / 2 + 8,
                 "world.city parallel streets must be distinct and non-overlapping with an 8m block gap")

    npc = world.get("npc")
    npc_index = npc.get("propIndex") if isinstance(npc, dict) else None
    need(integer(npc_index, 0, len(spec["props"]) - 1),
         "city requires world.npc.propIndex for the actual selected NPC")
    vehicles = array("vehicles")
    pedestrians = array("pedestrians")
    for i, car in enumerate(vehicles):
        path = f"world.city.vehicles[{i}]"
        if not obj(car, path, CITY_SCHEMA["properties"]["vehicles"]["items"]):
            continue
        identity(car, path)
        valid = position(car, path)
        need(isinstance(car.get("kind"), str) and car["kind"] in VEHICLES,
             f"{path}.kind must be {'|'.join(VEHICLES)}")
        need(number(car.get("yaw"), -math.pi, math.pi), f"{path}.yaw must be between -pi and pi")
        car.setdefault("color", spec["palette"]["accent"])
        need(isinstance(car["color"], str) and _HEX.fullmatch(car["color"]) is not None,
             f"{path}.color must be a #rrggbb hex color")
        if "modelId" in car:  # else the kit car of its kind
            body = next((e for e in world.get("entities") or []
                         if isinstance(e, dict) and isinstance(car["modelId"], str) and e.get("id") == car["modelId"]), None)
            need(body is not None and body.get("kind") == "model" and body.get("car") in ("player", "rival"),
                 f"{path}.modelId must name a car body: a world.entities kind model with car player|rival")
        if valid:
            need(near_street(car, valid_streets, 2), f"{path} must start on a connected road")
    for i, pedestrian in enumerate(pedestrians):
        path = f"world.city.pedestrians[{i}]"
        if not obj(pedestrian, path, CITY_SCHEMA["properties"]["pedestrians"]["items"]):
            continue
        identity(pedestrian, path)
        valid = position(pedestrian, path)
        need(integer(pedestrian.get("propIndex"), 0, len(spec["props"]) - 1)
             and pedestrian.get("propIndex") == npc_index,
             f"{path}.propIndex must use the actual selected NPC slot")
        route = pedestrian.get("route")
        if not need(isinstance(route, list) and 2 <= len(route) <= 8, f"{path}.route must contain 2-8 points"):
            continue
        for j, waypoint in enumerate(route):
            valid &= point(waypoint, f"{path}.route[{j}]")
        if valid:
            need(near_street(pedestrian, valid_streets), f"{path} must start on a road or sidewalk")
            need(len({(p["x"], p["z"]) for p in route}) >= 2, f"{path}.route must contain distinct waypoints")
            for a, b in zip([pedestrian, *route], [*route, route[0]]):
                need(_walkable_segment(a, b, valid_streets),
                     f"{path}.route segments must follow connected roads or sidewalks")
    if errors:
        return None
    return {"vehicles": vehicles, "pedestrians": pedestrians, "streets": valid_streets}
