"""Bounded authored-world contract. Model output is data, never game code."""
from __future__ import annotations

import math
import re
from collections import deque
from server.city_contract import CITY_SCHEMA, near_street, validate_city

KINDS = ("box", "cylinder", "spire", "arch", "tree", "crystal", "building", "platform", "beacon", "hazard", "model")
TIMES_OF_DAY = ("day", "dusk", "night")
WEATHERS = ("clear", "rain", "snow")
# What the runtime builds around the play area: a harbor's quay, water and cranes (game3d/biome.js), or sky islands
# over a cloud sea with no floor (game3d/sky.js)
SETTINGS = ("harbor", "sky")
BIOMES = ("forest", "desert", "snow", "ruins", "industrial", "volcanic", "night-city", "crypt", "temple")
IP_ID = re.compile(r"ip_[A-Za-z0-9_-]{1,64}")
STAGE_TYPES = ("collect", "kills", "reach", "interact", "survive", "boss", "talk", "drive", "race")
MOVING_KINDS = ("platform", "hazard", "box", "model")  # entity motion: moving platforms and traps
PICKUP_KINDS = ("model", "crystal")  # entity pickup: a reach target that is taken on touch (coins)
IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,47}")
HEX = re.compile(r"#[0-9a-fA-F]{6}")


def _obj(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


def _num(lo, hi):
    return {"type": "number", "minimum": lo, "maximum": hi}


def _int(lo, hi):
    return {"type": "integer", "minimum": lo, "maximum": hi}


ID = {"type": "string", "pattern": IDENTIFIER.pattern, "maxLength": 48}
COLOR = {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"}
LABEL = {"type": "string", "minLength": 1, "maxLength": 100}
POINT = _obj({"x": _num(-600, 600), "z": _num(-600, 600)}, ("x", "z"))
POSITION = {"id": ID, "x": _num(-600, 600), "z": _num(-600, 600)}
PLACEMENT = {**POSITION, "propIndex": _int(0, 23), "stageId": ID}
SPAWN = {**POSITION, "enemyIndex": _int(0, 4), "stageId": ID}

# tools.py merges these into its GameSpec tool schema. The Python validator below stays authoritative for
# version/engine, cross references, template sizes, geometry bounds and achievable stage counts.
AUTHORED_PROPERTIES = {
    "world": _obj({
        "width": _num(36, 1200), "depth": _num(36, 1200), "groundColor": COLOR, "spawn": POINT,
        "entities": {"type": "array", "maxItems": 72, "items": _obj({
            **POSITION, "kind": {"type": "string", "enum": list(KINDS)},
            "y": _num(0, 8), "width": _num(.3, 20), "depth": _num(.3, 20),
            "height": _num(.1, 18), "rotation": _num(-math.pi, math.pi), "color": COLOR,
            "emissive": COLOR, "solid": {"type": "boolean"}, "label": LABEL,
            "ipId": {"type": "string", "pattern": r"^ip_[A-Za-z0-9_-]{1,64}$", "maxLength": 67},
            "motion": _obj({"axis": {"type": "string", "enum": ["x", "y", "z"]}, "distance": _num(.5, 12),
                            "periodSec": _num(1, 12)}, ("axis", "distance")),
            "pickup": {"type": "boolean"},
            "car": {"type": "string", "enum": ["player", "rival"]},  # kind model: a race car body (race.js)
        }, ("id", "kind", "x", "z"))},
        "propPlacements": {"type": "array", "maxItems": 24,
                           "items": _obj(PLACEMENT, ("id", "propIndex", "x", "z"))},
        "enemySpawns": {"type": "array", "maxItems": 16,
                        "items": _obj(SPAWN, ("id", "enemyIndex", "x", "z"))},
        "npc": _obj({**POSITION, "name": LABEL, "propIndex": _int(0, 23)}, ("x", "z")),
        "background": _obj({
            "ipId": {"type": "string", "pattern": r"^ip_[A-Za-z0-9_-]{1,64}$", "maxLength": 67},
            "mode": {"type": "string", "enum": ["image", "model"]},
            "rotation": _num(-math.pi, math.pi),
        }, ("ipId", "mode")),
        "city": CITY_SCHEMA,
        # an open-track race on a biome: a road through the race stage's checkpoints (track.js)
        "track": _obj({"roadWidth": _num(8, 24)}),
    }, ("width", "depth", "spawn", "entities", "propPlacements", "enemySpawns")),
    "mission": _obj({
        "title": LABEL, "successText": {"type": "string", "minLength": 1, "maxLength": 200},
        "stages": {"type": "array", "minItems": 1, "maxItems": 8, "items": _obj({
            "id": ID, "type": {"type": "string", "enum": list(STAGE_TYPES)}, "label": LABEL,
            "target": _int(1, 200),
            "entityIds": {"type": "array", "minItems": 1, "maxItems": 24,
                          "uniqueItems": True, "items": ID},
            "propIndex": _int(0, 23), "enemyIndex": _int(0, 4), "holdSec": _num(0, 15),
            "distanceMeters": _num(20, 1500),
            "vehicleId": ID, "rivals": _int(0, 5),  # race only: the player's car and AI rival cars
            "finishRank": _int(1, 6),  # race only: the place needed to win
            # an episode beat shown when the stage begins
            "story": _obj({"speaker": {"type": "string", "minLength": 1, "maxLength": 40},
                           "text": {"type": "string", "minLength": 1, "maxLength": 200}}, ("speaker", "text")),
            "vehicle": {"type": "boolean"},  # city reach/interact: only counts while driving
        }, ("id", "type", "label", "target"))},
    }, ("stages",)),
    "mechanics": _obj({
        "dash": {"type": "boolean"}, "jump": {"type": "boolean"}, "sprint": {"type": "boolean"},
        "autoFire": {"type": "boolean"}, "regenPerSec": _num(0, 15), "weaponDamage": _num(1, 5),
        "fireIntervalSec": _num(.08, 2), "interactRadius": _num(1, 4),
        # arpg: Diablo-like play (top-down camera, melee combos, XP and levels, loot drops, enemy packs)
        "style": {"type": "string", "enum": ["action", "arpg"]},
        # platformer: falling to the floor puts the player back on the last platform stood on
        "fallRespawn": {"type": "boolean"},
    }),
    "artDirection": _obj({
        "skyColor": COLOR, "fogColor": COLOR, "fogDensity": _num(0, .06),
        "exposure": _num(.5, 2), "bloomStrength": _num(0, 1.5),
        "biome": {"type": "string", "enum": list(BIOMES)},
        # the request's light and weather over the biome photo (game3d/biome.js applyNight, makeWeather)
        "timeOfDay": {"type": "string", "enum": list(TIMES_OF_DAY)},
        "weather": {"type": "string", "enum": list(WEATHERS)},
        "setting": {"type": "string", "enum": list(SETTINGS)},
    }),
}


def _finite(*values):
    return all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in values)


def platform_under(platforms, x, z):
    """The highest platform whose rotated footprint holds (x, z), or None (authored.js platformUnder)."""
    best = None
    for p in platforms:
        c, s, dx, dz = math.cos(p["rotation"]), math.sin(p["rotation"]), x - p["x"], z - p["z"]
        if abs(dx * c - dz * s) <= p["width"] / 2 and abs(dx * s + dz * c) <= p["depth"] / 2 \
                and (best is None or p["y"] + p["height"] > best["y"] + best["height"]):
            best = p
    return best


def _platforms(geometry):
    return [p for p in geometry if isinstance(p, dict) and p.get("kind") == "platform" and isinstance(p.get("id"), str)
            and _finite(*(p.get(k) for k in ("x", "z", "y", "width", "depth", "height", "rotation")))]


# The platformer's climb (game3d/world.js JUMP): a jump peaks 1.46 m up and lands on a top up to .3 m above the feet,
# so 1.2 m top to top keeps a margin; a walking jump at that rise carries ~3.1 m, so 2.5 m edge to edge.
# game3d/test/round11.test.mjs checks these against the runtime's numbers.
STEP_RISE = 1.2
STEP_GAP = 2.5
STONE = 2.4  # a stepping stone's footprint (m)
MAX_ENTITIES = 72


def _extent(p):
    """The rotated footprint's bounding box, swept by x/z motion (a moving platform is reachable while it passes)."""
    c, s = abs(math.cos(p["rotation"])), abs(math.sin(p["rotation"]))
    hx, hz = (p["width"] * c + p["depth"] * s) / 2, (p["width"] * s + p["depth"] * c) / 2
    motion = p.get("motion") if isinstance(p.get("motion"), dict) else {}
    sweep = motion.get("distance", 0) / 2 if _finite(motion.get("distance")) else 0
    if motion.get("axis") == "x":
        hx, hz = hx + c * sweep, hz + s * sweep
    elif motion.get("axis") == "z":
        hx, hz = hx + s * sweep, hz + c * sweep
    return p["x"] - hx, p["x"] + hx, p["z"] - hz, p["z"] + hz


def _nearest(a, b):
    """Nearest points (x, z) of two footprint boxes, a's then b's (the middle of an overlap on an axis)."""
    pa, pb = [], []
    for lo_a, hi_a, lo_b, hi_b in ((a[0], a[1], b[0], b[1]), (a[2], a[3], b[2], b[3])):
        if hi_a < lo_b:
            pa.append(hi_a); pb.append(lo_b)
        elif hi_b < lo_a:
            pa.append(lo_a); pb.append(hi_b)
        else:
            mid = (max(lo_a, lo_b) + min(hi_a, hi_b)) / 2
            pa.append(mid); pb.append(mid)
    return pa, pb


def _top(p, high=False):
    """A platform's top; a lift (y motion) reaches `distance` higher, which counts when it is the step up from."""
    motion = p.get("motion") if isinstance(p.get("motion"), dict) else {}
    lift = motion.get("distance", 0) if high and motion.get("axis") == "y" and _finite(motion.get("distance")) else 0
    return p["y"] + p["height"] + lift


def connect_climb(geometry, ground=None):
    """Platformer (mechanics.fallRespawn) normalization: every platform can be reached from the floor the hero starts
    on (in a sky world, from its ground islands: `ground`), one jump at a time. Platforms within STEP_RISE up and
    STEP_GAP across of the floor or of a reached platform are reached. When none is, the unreached platform nearest
    the climb so far is joined to that reached top: lowered to STEP_RISE above it, with what stands on it, and a gap
    wider than STEP_GAP gets stepping stones (or, with no room left in the entity list, the platform moves closer).
    Returns what changed, for the log."""
    platforms = _platforms(geometry)
    if not platforms:
        return []
    ids = {e.get("id") for e in geometry if isinstance(e, dict)}
    # A sky world has no floor: its ground islands (top y = 0) are where the climb starts
    changes, reached, left = [], list(ground or []), list(platforms)
    floor = [None] if ground is None else []

    def link(source, p):  # (rise, gap) from a reached top (None: the floor) to platform p
        if source is None:
            return _top(p), 0.0
        pa, pb = _nearest(_extent(source), _extent(p))
        return _top(p) - _top(source, high=True), math.hypot(pb[0] - pa[0], pb[1] - pa[1])

    def riders(p):  # what stands on p (a flag, a building, a coin): it moves with p
        x0, x1, z0, z1 = _extent(p)
        return [e for e in geometry if isinstance(e, dict) and e is not p and e.get("kind") != "platform"
                and _finite(e.get("x"), e.get("z")) and x0 <= e["x"] <= x1 and z0 <= e["z"] <= z1
                and p["y"] - .05 <= (e.get("y") or 0) <= _top(p) + .05]

    def ok(rise, gap):
        return rise <= STEP_RISE + 1e-6 and gap <= STEP_GAP + 1e-6

    for _ in range(4 * len(platforms) + 4):  # each pass reaches or fixes one platform at least
        new = [p for p in left if any(ok(*link(s, p)) for s in [*floor, *reached])]
        if new:
            reached += new
            left = [p for p in left if all(p is not q for q in new)]
            continue
        if not left:
            break
        p, source = min(((p, s) for p in left for s in (reached or [None])),
                        key=lambda ps: (link(ps[1], ps[0])[1], link(ps[1], ps[0])[0]))
        rise, gap = link(source, p)
        if rise > STEP_RISE:
            drop, carried = rise - STEP_RISE, riders(p)
            new_top = _top(p) - drop
            p["y"] = round(max(0.0, p["y"] - drop), 3)
            p["height"] = round(max(.1, new_top - p["y"]), 3)
            for e in carried:
                e["y"] = round(max(0.0, (e.get("y") or 0) - drop), 3)
            changes.append(f"{p['id']}: {drop:.2f} m lower")
        if gap > STEP_GAP:
            pa, pb = _nearest(_extent(source), _extent(p))
            count = math.ceil((gap - STEP_GAP) / (STEP_GAP + STONE))
            if len(geometry) + count <= MAX_ENTITIES:
                space = (gap - count * STONE) / (count + 1)
                lo, hi = _top(source, high=True), _top(p)
                for k in range(count):
                    t = (space * (k + 1) + STONE * (k + .5)) / gap
                    stone_top = lo + (hi - lo) * (k + 1) / (count + 1)
                    height = min(1.0, max(.1, stone_top))
                    n = 1
                    while f"step_{p['id']}_{n}"[:48] in ids:
                        n += 1
                    sid = f"step_{p['id']}_{n}"[:48]
                    ids.add(sid)
                    stone = {"id": sid, "kind": "platform", "x": round(pa[0] + (pb[0] - pa[0]) * t, 3),
                             "z": round(pa[1] + (pb[1] - pa[1]) * t, 3), "y": round(stone_top - height, 3),
                             "width": STONE, "depth": STONE, "height": round(height, 3), "rotation": 0,
                             "solid": True, "color": p.get("color", "#ffffff")}
                    geometry.append(stone)
                    reached.append(stone)
                changes.append(f"{p['id']}: {count} stepping stone(s)")
            else:
                pull, carried = gap - STEP_GAP + .05, riders(p)
                dx, dz = (pa[0] - pb[0]) / gap, (pa[1] - pb[1]) / gap
                for e in (p, *carried):
                    e["x"], e["z"] = round(e["x"] + dx * pull, 3), round(e["z"] + dz * pull, 3)
                changes.append(f"{p['id']}: {pull:.2f} m closer")
    return changes


# Sky islands (artDirection.setting "sky", game3d/sky.js SKY and skyIslands): the floor is solid only on ground
# islands, squares with their top at y = 0: one under the spawn, one under each entity standing on the floor, and one
# under each enemy spawn, the NPC and any prop off the platforms.
SKY_HOME = 8.0
SKY_PAD = 1.5
SKY_SPOT = 5.0


def sky_islands(world):
    """A sky world's ground islands as platform-shaped dicts (connect_climb sources), the runtime's skyIslands."""
    entities = [e for e in world.get("entities") or [] if isinstance(e, dict) and _finite(e.get("x"), e.get("z"))]
    platforms = _platforms(entities)

    def isle(x, z, size, ident):
        return {"id": ident, "kind": "island", "x": x, "z": z, "y": 0.0, "height": 0.0, "width": size, "depth": size,
                "rotation": 0.0}

    spawn = world.get("spawn") if isinstance(world.get("spawn"), dict) else {}
    out = [isle(spawn["x"], spawn["z"], SKY_HOME, "home")] if _finite(spawn.get("x"), spawn.get("z")) else []
    for e in entities:
        if e.get("kind") == "platform" or (e.get("y") or 0) >= .05 or platform_under(platforms, e["x"], e["z"]):
            continue
        size = max(e.get("width") or 2, e.get("depth") or 2) + 2 * SKY_PAD
        out.append(isle(e["x"], e["z"], size, e.get("id")))
    npc = world.get("npc")
    spots = [*(world.get("enemySpawns") or []), *([{"id": "npc", **npc}] if isinstance(npc, dict) else []),
             *(p for p in world.get("propPlacements") or []
               if isinstance(p, dict) and _finite(p.get("x"), p.get("z")) and not platform_under(platforms, p["x"], p["z"]))]
    for p in spots:
        if isinstance(p, dict) and _finite(p.get("x"), p.get("z")):
            out.append(isle(p["x"], p["z"], SKY_SPOT, p.get("id")))
    return out


def settle_sky(spec):
    """A sky world is a platformer over the clouds: a fall off the islands respawns (mechanics.fallRespawn, jump on),
    the props sit on the platforms (seat_collectibles), and the climb starts from the ground islands (connect_climb).
    → what changed, for the log"""
    world = spec.get("world")
    if not isinstance(world, dict) or not isinstance(world.get("entities"), list):
        return []
    mechanics = spec.setdefault("mechanics", {})
    if isinstance(mechanics, dict):
        mechanics["fallRespawn"] = True
        mechanics["jump"] = True
    placements = [p for p in world.get("propPlacements") or [] if isinstance(p, dict)]
    seat_collectibles(world["entities"], placements)
    return connect_climb(world["entities"], start_islands(sky_islands(world)))


def start_islands(islands):
    """The ground islands the hero can get to from the one it starts on (home), one jump across at a time: where the
    climb starts (a far-off enemy's island is not a start). Without a home island, all of them."""
    home = [i for i in islands if i.get("id") == "home"][:1]
    if not home:
        return islands
    reached, left = home, [i for i in islands if i is not home[0]]
    while True:
        new = [i for i in left if any(_reach_gap(r, i) <= STEP_GAP + 1e-6 for r in reached)]
        if not new:
            return reached
        reached, left = reached + new, [i for i in left if all(i is not n for n in new)]


def _reach_gap(a, b):
    pa, pb = _nearest(_extent(a), _extent(b))
    return math.hypot(pb[0] - pa[0], pb[1] - pa[1])


def seat_collectibles(geometry, placements):
    """Platformer (mechanics.fallRespawn) normalization: the loop is climb → collect → top flag. A collectible on
    the floor is picked up without one jump, and once the player climbs, every floor touch puts them back on a
    platform. So each prop placement or pickup coin not over a platform moves onto the nearest platform that holds
    none yet (else the nearest), and a coin takes its platform's level (the runtime puts it on the top)."""
    platforms = _platforms(geometry)
    coins = [e for e in geometry if isinstance(e, dict) and e.get("pickup") is True]
    items = [i for i in [*placements, *coins] if isinstance(i, dict) and _finite(i.get("x"), i.get("z"))]
    if not platforms:
        return
    taken = {seat["id"] for seat in (platform_under(platforms, i["x"], i["z"]) for i in items) if seat}
    for item in items:
        seat = platform_under(platforms, item["x"], item["z"])
        if seat is None:
            free = [p for p in platforms if p["id"] not in taken] or platforms
            seat = min(free, key=lambda p: math.hypot(p["x"] - item["x"], p["z"] - item["z"]))
            item["x"], item["z"] = seat["x"], seat["z"]
            taken.add(seat["id"])
        if item.get("pickup") is True:
            item["y"] = seat["y"]


# ── a survive stage an idle hero cannot clear ─────────────────────────────────
# What the runtime does with a survive spec (game3d/authored.js, arpg-data.js; game3d/test/round20-survive.test.mjs):
#  - enemies walk 2.2 m/s, so far spawn points mean 10 s or more before a blow
#  - autoFire shoots the nearest enemy within 15 m, and a hit breaks that enemy's wind-up: a hero who stands still wins
#  - without it, an idle hero loses about 4.8 HP a second at 보통 once the horde is on them (쉬움 3.1, 어려움 8.3+)
# So a new game's survive stage is settled on three numbers: spawn points close to the start, no automatic attack
# unless the user asked for one, and HP an idle hero loses well inside the stage's clock. A hero who moves loses little.
SURVIVE_NEAR = 16.0  # a spawn point this close to the start has its enemy in reach of a blow within ~6 s
SURVIVE_NEAR_POINTS = 4  # a wave comes from the four spawn points nearest the hero (authored.js surviveWaves)
SURVIVE_RING = (12.5, 14.5, 15.5)  # where points are added: the runtime keeps a round's first enemies 12 m off
SURVIVE_FIRST_BLOW_SEC = 5.0  # a near spawn's first bolt or blow (measured 4.5–5.0 s)
SURVIVE_IDLE_HP_PER_SEC = {"easy": 3.0, "normal": 4.4, "hard": 8.0}  # under the measured rates above
# The share of the stage's clock by which an idle hero is down
SURVIVE_IDLE_SHARE = .7
MIN_PLAYER_HP, MAX_SPAWNS = 50, 16  # rules.playerHp's floor (gamespec.py), world.enemySpawns' size (AUTHORED_PROPERTIES)
_DIFFICULTY_LABEL = {"easy": "쉬움", "normal": "보통", "hard": "어려움"}


def survive_hp_cap(seconds, difficulty) -> int:
    """The most HP a hero may have for a survive stage of `seconds` so that standing still loses it: what the horde
    takes from an idle hero in SURVIVE_IDLE_SHARE of the clock, from its first blow on. Never under the contract's
    floor, so a stage shorter than ~25 s cannot be made to kill an idle hero."""
    rate = SURVIVE_IDLE_HP_PER_SEC.get(difficulty, SURVIVE_IDLE_HP_PER_SEC["normal"])
    return max(MIN_PLAYER_HP, math.floor(rate * (SURVIVE_IDLE_SHARE * seconds - SURVIVE_FIRST_BLOW_SEC)))


def _in_solid(world, x, z, radius=1.0) -> bool:
    """Whether a placement at (x, z) would overlap solid geometry, as validate_authored refuses it (blocked)."""
    for e in world.get("entities") or []:
        if not isinstance(e, dict) or e.get("solid", e.get("kind") not in ("beacon", "hazard")) is not True:
            continue
        y, height, rotation = e.get("y") or 0, e.get("height", 2), e.get("rotation") or 0
        if not _finite(e.get("x"), e.get("z"), y, height, rotation) or y >= 1.8 or y + height <= 0:
            continue
        c, s = abs(math.cos(rotation)), abs(math.sin(rotation))
        width, depth = e.get("width", 2), e.get("depth", 2)
        if abs(x - e["x"]) < (width * c + depth * s) / 2 + radius and abs(z - e["z"]) < (width * s + depth * c) / 2 + radius:
            return True
    return False


def settle_survive(spec, tune=True, keep_hp=False, keep_auto=False) -> list:
    """A game whose mission has a survive stage cannot be cleared by standing still (see above). An authored action
    world only: a city, a track, sky islands, a platformer and an ARPG keep their own rules.
     - the mission opens with the survive stage: SURVIVE_NEAR_POINTS of its spawn points lie within SURVIVE_NEAR of
       the start, first in the list (the runtime brings them in in that order). Missing ones are added on a ring
       around the start, inside the world and off solid geometry; with the list full, the stage's farthest points
       move there instead.
     - tune (a new game, not a revision of one): autoFire is off unless the user asked for it (keep_auto), and
       rules.playerHp is at most survive_hp_cap of the shortest survive stage unless the user named it (keep_hp).
       The HP is capped only in a mission whose fights are all survive stages: rules.playerHp is the one HP of the
       whole game (authored.js refills it only after a death), so a boss or kill stage of the same mission keeps it.
    → what changed, in sentences the agent can pass on (make_game's result)."""
    world, mission = spec.get("world"), spec.get("mission")
    mechanics, art = spec.get("mechanics") or {}, spec.get("artDirection") or {}
    if not isinstance(world, dict) or not isinstance(mission, dict) or not spec.get("enemies") \
            or "city" in world or "track" in world or art.get("setting") == "sky" \
            or mechanics.get("fallRespawn") is True or mechanics.get("style") == "arpg":
        return []
    stages = [s for s in mission.get("stages") or [] if isinstance(s, dict)]
    survive = [s for s in stages if s.get("type") == "survive" and _finite(s.get("target"))]
    if not survive:
        return []
    changed = []
    spawns, start = world.get("enemySpawns"), world.get("spawn")
    if stages[0] is survive[0] and isinstance(spawns, list) and isinstance(start, dict) \
            and _finite(start.get("x"), start.get("z"), world.get("width"), world.get("depth")):
        added = _near_spawns(spec, world, survive[0], spawns, start)
        if added:
            changed.append(f"시작점 가까이(12–16m)에 적이 나오는 곳 {added}곳을 두었습니다: 첫 적이 몇 초 안에 주인공에게 "
                           "닿습니다.")
    if not tune:
        return changed
    if mechanics.get("autoFire") is True and not keep_auto:
        spec["mechanics"]["autoFire"] = False
        changed.append("자동 공격을 껐습니다: 켜 두면 가만히 서 있어도 생존 단계를 깰 수 있습니다. 공격은 클릭 또는 F입니다. "
                       "사용자가 자동 공격을 원한다고 말하면 그때 켭니다.")
    if any(s.get("type") in ("kills", "boss") for s in stages):  # another fight shares the game's one HP
        return changed
    shortest = min(survive, key=lambda s: s["target"])
    difficulty = spec.get("difficulty")
    cap = survive_hp_cap(shortest["target"], difficulty)
    rules = spec.get("rules") if isinstance(spec.get("rules"), dict) else {}
    hp = rules.get("playerHp", 100)  # the runtime's own default (authored.js)
    if not keep_hp and _finite(hp) and hp > cap:
        spec["rules"] = {**rules, "playerHp": cap}
        changed.append(f"주인공 체력을 {hp:g}에서 {cap}(으)로 낮췄습니다: {shortest['target']:g}초 생존({_DIFFICULTY_LABEL.get(difficulty, '보통')})"
                       "에서 가만히 서 있으면 시간이 다 되기 전에 쓰러집니다. 움직이며 피하면 거의 맞지 않습니다.")
    return changed


def hero_attack(spec) -> str:
    """How the hero fights in an authored game as the runtime plays this spec, in one sentence for make_game's result
    (the agent's copy). The conditions are the runtime's own, in its order: game3d/arpg-data.js controlsFor (a race
    has no attack key; an ARPG has its own two) and game3d/authored.js (combat is on with an enemy, a hand weapon or
    autoFire; attack() swings a melee weapon and otherwise fires a bolt, from the chest when the hand is empty)."""
    world, player = spec.get("world") or {}, spec.get("player") or {}
    mechanics = spec.get("mechanics") or {}
    auto = mechanics.get("autoFire") is True
    if world.get("track") is not None or not (mechanics.get("style") == "arpg" or spec.get("enemies") or player.get("weaponUrl") or auto):
        return "이 게임에는 공격이 없습니다: 주인공은 싸우지 않습니다."
    if mechanics.get("style") == "arpg":
        return "주인공은 마우스 클릭이나 F 키로 연속 베기를 하고, 레벨 3부터 R 키로 회오리 베기를 씁니다(자동 공격 없음)."
    how = ("주인공은 15m 안의 가장 가까운 적을 자동으로 공격하고, 마우스 클릭이나 F 키로도 공격합니다." if auto
           else "주인공은 마우스 클릭이나 F 키를 누를 때 공격합니다(자동 공격은 꺼져 있음).")
    if not player.get("weaponUrl"):
        return f"{how} 손에 든 무기가 없어도 탄환을 쏴 적을 쓰러뜨립니다."
    if player.get("weaponType", "melee") == "melee":  # (world.js loadWeapon: a hand weapon is melee unless it says gun)
        return f"{how} 손에 든 무기를 휘둘러 앞쪽 가까이의 적을 칩니다."
    return f"{how} 손에 든 무기로 탄환을 쏩니다."


def _near_spawns(spec, world, stage, spawns, start) -> int:
    """Bring SURVIVE_NEAR_POINTS of the opening survive stage's spawn points within SURVIVE_NEAR of the start and put
    the near ones first. → how many points were added or moved."""
    def own(p):  # authored.js firstStageFor: no stageId goes to the first survive stage
        return isinstance(p, dict) and _finite(p.get("x"), p.get("z")) and p.get("stageId") in (None, stage.get("id"))

    def off(p):
        return math.hypot(p["x"] - start["x"], p["z"] - start["z"])

    mine = [p for p in spawns if own(p)]
    near = [p for p in mine if off(p) <= SURVIVE_NEAR]
    need, placed = SURVIVE_NEAR_POINTS - len(near), 0
    if need > 0:
        # the enemies this stage already sends; else every enemy no boss stage keeps for itself
        bosses = {s.get("enemyIndex") for s in spec["mission"]["stages"] if isinstance(s, dict) and s.get("type") == "boss"}
        kinds = list(dict.fromkeys(p.get("enemyIndex") for p in mine)) or \
            [i for i in range(len(spec["enemies"])) if i not in bosses] or [0]
        taken = {e.get("id") for group in ("entities", "propPlacements", "enemySpawns") for e in world.get(group) or []
                 if isinstance(e, dict)} | {(world.get("npc") or {}).get("id", "npc")}
        far = sorted((p for p in mine if all(p is not q for q in near)), key=off, reverse=True)
        for x, z in _ring_spots(world, start, [p for p in spawns if isinstance(p, dict)], need):
            if len(spawns) < MAX_SPAWNS:
                ident = next(f"near_{k}" for k in range(1, 99) if f"near_{k}" not in taken)
                taken.add(ident)
                point = {"id": ident, "enemyIndex": kinds[placed % len(kinds)], "x": x, "z": z,
                         **({"stageId": stage["id"]} if isinstance(stage.get("id"), str) else {})}
                spawns.append(point)
            elif far:  # the list is full: the stage's farthest point comes in instead
                point = far.pop(0)
                point["x"], point["z"] = x, z
            else:
                break
            near.append(point)
            placed += 1
    spawns.sort(key=lambda p: all(p is not q for q in near))  # stable: the near ones first, each group in its order
    return placed


def _ring_spots(world, start, spawns, need) -> list:
    """Up to `need` free places around the start, spread over the bearings of a ring that are inside the world (1.5 m
    off its edge), off solid geometry and 3 m from every spawn point there is; the first ring of SURVIVE_RING that
    has room for all of them, else the one with the most. → [(x, z)]"""
    half_w, half_d = world["width"] / 2 - 1.5, world["depth"] / 2 - 1.5
    best = []
    for radius in SURVIVE_RING:
        free = []
        for k in range(12):
            a = (k + .5) * math.pi / 6
            x, z = round(start["x"] + math.cos(a) * radius, 1), round(start["z"] + math.sin(a) * radius, 1)
            if abs(x) <= half_w and abs(z) <= half_d and not _in_solid(world, x, z) \
                    and all(math.hypot(x - p["x"], z - p["z"]) >= 3 for p in spawns if _finite(p.get("x"), p.get("z"))):
                free.append((x, z))
        best = free if len(free) > len(best) else best
        if len(best) >= need:
            break
    count = min(need, len(best))
    return [best[i * len(best) // count] for i in range(count)]


def validate_authored(spec, errors):
    """Validate/normalize only v2 sections on an already-deepcopied GameSpec."""
    def need(ok, message):
        if not ok:
            errors.append(message)
        return bool(ok)

    def obj(value, path, keys):
        if not need(isinstance(value, dict), f"{path} must be an object"):
            return False
        need(not set(value) - set(keys), f"{path} contains unsupported fields")
        return True

    def number(value, lo, hi):
        return (isinstance(value, (int, float)) and not isinstance(value, bool)
                and lo <= value <= hi and math.isfinite(value))

    def integer(value, lo, hi):
        return number(value, lo, hi) and int(value) == value

    def identifier(value, path):
        return need(isinstance(value, str) and IDENTIFIER.fullmatch(value) is not None,
                    f"{path} must be a bounded identifier")

    def label(value, path, limit=100):
        return need(isinstance(value, str) and 1 <= len(value.strip()) <= limit,
                    f"{path} must be a non-empty string of at most {limit} characters")

    def color(value, path):
        return need(isinstance(value, str) and HEX.fullmatch(value) is not None,
                    f"{path} must be a #rrggbb hex color")

    need(spec.get("engine") == "three", "version 2 requires engine three")
    props, enemies = spec.get("props"), spec.get("enemies")
    props = props if isinstance(props, list) else []
    enemies = enemies if isinstance(enemies, list) else []
    need(len(props) <= 24, "version 2 props must contain at most 24 templates")
    for path in ["player", "props", "enemies"]:
        values = [spec.get("player")] if path == "player" else (props if path == "props" else enemies)
        for i, value in enumerate(values):
            where = path if path == "player" else f"{path}[{i}]"
            if isinstance(value, dict):
                need(isinstance(value.get("ipId"), str) and 1 <= len(value["ipId"]) <= 128,
                     f"{where}.ipId must reference an existing IP")

    world = spec.get("world")
    if not obj(world, "world", AUTHORED_PROPERTIES["world"]["properties"]):
        return
    background = world.get("background")
    if background is not None:
        # URLs are resolved from owned IP records after validation: model output never selects a network location
        if isinstance(background, dict):
            background.pop("imageUrl", None)
            background.pop("modelUrl", None)
        if obj(background, "world.background", AUTHORED_PROPERTIES["world"]["properties"]["background"]["properties"]):
            need(isinstance(background.get("ipId"), str)
                 and re.fullmatch(r"ip_[A-Za-z0-9_-]{1,64}", background["ipId"]) is not None,
                 "world.background.ipId must reference an existing bounded IP")
            need(background.get("mode") in ("image", "model"), "world.background.mode must be image|model")
            rotation = background.setdefault("rotation", 0)
            need(number(rotation, -math.pi, math.pi), "world.background.rotation must be a number -pi..pi")
            if background.get("mode") == "image":
                need(rotation == 0, "world.background image mode supports rotation 0 only")
    elif "background" in world:
        need(False, "world.background must be an object")
    city_mode = "city" in world
    track_mode = "track" in world
    arpg = isinstance(spec.get("mechanics"), dict) and spec["mechanics"].get("style") == "arpg"
    minimum, maximum = (300, 1200) if city_mode else (200, 800) if track_mode else (36, 160) if arpg else (36, 100)
    if track_mode:
        need(not city_mode, "world.track and world.city cannot be combined")
        if obj(world["track"], "world.track", ("roadWidth",)) and "roadWidth" in world["track"]:
            need(number(world["track"]["roadWidth"], 8, 24), "world.track.roadWidth must be a number 8-24")
    valid_bounds = True
    for key in ("width", "depth"):
        valid_bounds &= need(number(world.get(key), minimum, maximum),
                             f"world.{key} must be a number {minimum}-{maximum}")
    if not valid_bounds:
        return
    half_w, half_d = world["width"] / 2, world["depth"] / 2
    if "groundColor" in world:
        color(world["groundColor"], "world.groundColor")
    else:
        world["groundColor"] = spec["palette"]["bg"]

    def position(item, path, margin=1):
        valid = True
        for key, half in (("x", half_w), ("z", half_d)):
            valid &= need(number(item.get(key), -half + margin, half - margin),
                          f"{path}.{key} must stay within world bounds")
        return bool(valid)

    spawn = world.get("spawn")
    valid_spawn = obj(spawn, "world.spawn", ("x", "z")) and position(spawn, "world.spawn")
    records, solids, positions = {}, [], []

    def record(item, path, kind):
        if not identifier(item.get("id"), f"{path}.id"):
            return False
        if not need(item["id"] not in records, f"{path}.id must be unique across the world"):
            return False
        records[item["id"]] = (kind, item)
        if position(item, path):
            positions.append((path, item))
            return True
        return False

    def array(name, maximum):
        value = world.get(name)
        if not need(isinstance(value, list) and len(value) <= maximum,
                    f"world.{name} must be an array of 0-{maximum} items"):
            return []
        return value

    geometry = array("entities", 72)
    for i, item in enumerate(geometry):
        path = f"world.entities[{i}]"
        keys = AUTHORED_PROPERTIES["world"]["properties"]["entities"]["items"]["properties"]
        if not obj(item, path, keys):
            continue
        need(item.get("kind") in KINDS, f"{path}.kind must be {'|'.join(KINDS)}")
        if not record(item, path, "geometry"):
            continue
        valid = True
        for key, lo, hi, default in (
            ("width", .3, 20, 2), ("depth", .3, 20, 2), ("height", .1, 18, 2),
            ("y", 0, 8, 0), ("rotation", -math.pi, math.pi, 0),
        ):
            item.setdefault(key, default)
            valid &= need(number(item[key], lo, hi), f"{path}.{key} must be a number {lo}-{hi}")
        item.setdefault("solid", item.get("kind") not in ("beacon", "hazard"))
        if item.get("kind") == "platform":
            item["solid"] = True  # a platform is something to stand on; a ghost one swallows the player
        need(isinstance(item["solid"], bool), f"{path}.solid must be a boolean")
        item.setdefault("color", spec["palette"]["accent"])
        color(item["color"], f"{path}.color")
        if "emissive" in item:
            color(item["emissive"], f"{path}.emissive")
        if "label" in item:
            label(item["label"], f"{path}.label")
        if item.get("kind") == "model":  # a set piece: the user's own prop IP as a 3D model
            need(isinstance(item.get("ipId"), str) and IP_ID.fullmatch(item["ipId"]),
                 f"{path}.ipId must name the prop IP whose 3D model this set piece shows")
        else:
            need("ipId" not in item, f"{path}.ipId is only for kind model")
        motion = item.get("motion")
        if motion is not None:
            if need(item.get("kind") in MOVING_KINDS, f"{path}.motion is only for {'|'.join(MOVING_KINDS)}") \
                    and obj(motion, f"{path}.motion", ("axis", "distance", "periodSec")):
                need(motion.get("axis") in ("x", "y", "z"), f"{path}.motion.axis must be x|y|z")
                need(number(motion.get("distance"), .5, 12), f"{path}.motion.distance must be a number 0.5-12")
                motion.setdefault("periodSec", 4)
                need(number(motion["periodSec"], 1, 12), f"{path}.motion.periodSec must be a number 1-12")
        if "car" in item:
            need(item.get("kind") == "model" and item["car"] in ("player", "rival"),
                 f"{path}.car is player|rival on a kind model entity")
            item["solid"] = False
        if "pickup" in item:
            need(item["pickup"] is True and item.get("kind") in PICKUP_KINDS,
                 f"{path}.pickup must be true and only for {'|'.join(PICKUP_KINDS)}")
            item["solid"] = False
        item.pop("modelUrl", None)  # the server resolves the model; a sent URL is never used
        if not valid:
            continue
        c, s = abs(math.cos(item["rotation"])), abs(math.sin(item["rotation"]))
        rx = (item["width"] * c + item["depth"] * s) / 2
        rz = (item["width"] * s + item["depth"] * c) / 2
        need(abs(item["x"]) + rx <= half_w and abs(item["z"]) + rz <= half_d,
             f"{path} rotated geometry must fit within world bounds")
        if item["solid"] is True and item["y"] < 1.8 and "motion" not in item:  # moving pieces never seal a path
            solids.append((item, rx, rz))

    def template_index(item, key, templates, path):
        if need(integer(item.get(key), 0, len(templates) - 1),
                f"{path}.{key} must reference an existing template index"):
            item[key] = int(item[key])
            return True
        return False

    prop_placements = array("propPlacements", 24)
    enemy_spawns = array("enemySpawns", 16)
    for name, values, kind, key, templates in (
        ("propPlacements", prop_placements, "prop", "propIndex", props),
        ("enemySpawns", enemy_spawns, "enemy", "enemyIndex", enemies),
    ):
        for i, item in enumerate(values):
            path = f"world.{name}[{i}]"
            if not obj(item, path, AUTHORED_PROPERTIES["world"]["properties"][name]["items"]["properties"]):
                continue
            record(item, path, kind)
            template_index(item, key, templates, path)
            if "stageId" in item:
                identifier(item["stageId"], f"{path}.stageId")
    npc = world.get("npc")
    if npc is not None and obj(npc, "world.npc", AUTHORED_PROPERTIES["world"]["properties"]["npc"]["properties"]):
        npc.setdefault("id", "npc")
        record(npc, "world.npc", "npc")
        if "propIndex" in npc:
            template_index(npc, "propIndex", props, "world.npc")
        if "name" in npc:
            label(npc["name"], "world.npc.name")
    for index in range(len(props)):
        used = any(isinstance(p, dict) and p.get("propIndex") == index for p in prop_placements)
        used |= isinstance(npc, dict) and npc.get("propIndex") == index
        need(used, f"props[{index}] must be placed or assigned to world.npc")
    for index in range(len(enemies)):
        need(any(isinstance(e, dict) and e.get("enemyIndex") == index for e in enemy_spawns),
             f"enemies[{index}] must have an actual enemy spawn")
    sky = isinstance(spec.get("artDirection"), dict) and spec["artDirection"].get("setting") == "sky"
    if sky:
        settle_sky(spec)
    elif isinstance(spec.get("mechanics"), dict) and spec["mechanics"].get("fallRespawn") is True:
        connect_climb(geometry)
        seat_collectibles(geometry, prop_placements)

    city = validate_city(spec, errors, records) if city_mode else None
    if city:
        for role, values in (("vehicle", city["vehicles"]), ("pedestrian", city["pedestrians"])):
            for i, item in enumerate(values):
                record(item, f"world.city.{role}s[{i}]", role)
        for item, rx, rz in solids:
            need(not any(abs(item["z" if road["axis"] == "x" else "x"] - road["coordinate"])
                         < (rz if road["axis"] == "x" else rx) + road["width"] / 2 + 2
                         for road in city["streets"]),
                 f"world entity {item['id']} solid geometry must not block a city road")
        if valid_spawn:
            need(near_street(spawn, city["streets"]), "city world.spawn must be on a road or sidewalk")
        for path, item in positions:
            if records.get(item.get("id"), ("geometry",))[0] != "geometry":
                need(near_street(item, city["streets"]), f"{path} must be on a city road or sidewalk")

    def blocked(x, z, radius=.6, jump=False, platforms=True, floor=0):
        for item, rx, rz in solids:  # floor: the top the subject stands on; a solid ending at or under it is below it
            if (jump and item["height"] < 2) or (not platforms and item.get("kind") == "platform") \
                    or item["y"] + item["height"] <= floor:
                continue
            if abs(x - item["x"]) < rx + radius and abs(z - item["z"]) < rz + radius:
                return True
        return False

    if valid_spawn:
        need(not blocked(spawn["x"], spawn["z"], 1), "world.spawn overlaps solid geometry")
    seats = _platforms(geometry)
    for path, item in positions:
        role = records.get(item.get("id"), ("geometry",))[0]
        if role != "geometry":  # a collectible over a platform sits on its top (authored.js platformUnder)
            seat = platform_under(seats, item["x"], item["z"]) if role == "prop" else None
            need(not blocked(item["x"], item["z"], 1, platforms=role != "prop",
                             floor=seat["y"] + seat["height"] if seat else 0), f"{path} overlaps solid geometry")
    if city:
        for pedestrian in city["pedestrians"]:
            route = pedestrian["route"]
            for a, b in zip([pedestrian, *route], [*route, route[0]]):
                for item, rx, rz in solids:
                    if abs(a["z"] - b["z"]) < .001:
                        overlaps = (abs(a["z"] - item["z"]) < rz + .6
                                    and max(a["x"], b["x"]) > item["x"] - rx - .6
                                    and min(a["x"], b["x"]) < item["x"] + rx + .6)
                    else:
                        overlaps = (abs(a["x"] - item["x"]) < rx + .6
                                    and max(a["z"], b["z"]) > item["z"] - rz - .6
                                    and min(a["z"], b["z"]) < item["z"] + rz + .6)
                    need(not overlaps, f"pedestrian {pedestrian['id']} route overlaps solid geometry")
    # A beacon is a target point: one embedded in a solid wall fails even though the marker itself is not solid
    for i, item in enumerate(geometry):
        if isinstance(item, dict) and item.get("kind") == "beacon" and number(item.get("x"), -half_w, half_w) and number(item.get("z"), -half_d, half_d):
            need(not blocked(item["x"], item["z"], 1), f"world.entities[{i}] beacon overlaps solid geometry")

    mechanics = spec.setdefault("mechanics", {})
    if obj(mechanics, "mechanics", AUTHORED_PROPERTIES["mechanics"]["properties"]):
        mechanics.setdefault("autoFire", False)
        for key, value in mechanics.items():
            if key in {"dash", "jump", "sprint", "autoFire", "fallRespawn"}:
                need(isinstance(value, bool), f"mechanics.{key} must be a boolean")
            elif key == "style":
                need(value in ("action", "arpg"), "mechanics.style must be action|arpg")
            elif key in AUTHORED_PROPERTIES["mechanics"]["properties"]:
                rule = AUTHORED_PROPERTIES["mechanics"]["properties"][key]
                need(number(value, rule["minimum"], rule["maximum"]),
                     f"mechanics.{key} must be a bounded number")
    art = spec.setdefault("artDirection", {})
    if obj(art, "artDirection", AUTHORED_PROPERTIES["artDirection"]["properties"]):
        for key, value in art.items():
            if key in {"skyColor", "fogColor"}:
                color(value, f"artDirection.{key}")
            elif key == "biome":
                need(value in BIOMES, f"artDirection.biome must be {'|'.join(BIOMES)}")
            elif key in ("timeOfDay", "weather", "setting"):
                options = {"timeOfDay": TIMES_OF_DAY, "weather": WEATHERS, "setting": SETTINGS}[key]
                need(value in options, f"artDirection.{key} must be {'|'.join(options)}")
            elif key in AUTHORED_PROPERTIES["artDirection"]["properties"]:
                rule = AUTHORED_PROPERTIES["artDirection"]["properties"][key]
                need(number(value, rule["minimum"], rule["maximum"]), f"artDirection.{key} must be a bounded number")

    mission = spec.get("mission")
    if not obj(mission, "mission", AUTHORED_PROPERTIES["mission"]["properties"]):
        return
    for key, limit in (("title", 100), ("successText", 200)):
        if key in mission:
            label(mission[key], f"mission.{key}", limit)
    stages = mission.get("stages")
    if not need(isinstance(stages, list) and 1 <= len(stages) <= 8,
                "mission.stages must be an array of 1-8 stages"):
        return
    by_stage = {}
    for i, stage in enumerate(stages):
        path = f"mission.stages[{i}]"
        if not obj(stage, path, AUTHORED_PROPERTIES["mission"]["properties"]["stages"]["items"]["properties"]):
            continue
        if identifier(stage.get("id"), f"{path}.id"):
            if need(stage["id"] not in by_stage, f"{path}.id must be unique"):
                by_stage[stage["id"]] = stage
        kind = stage.get("type")
        if not isinstance(kind, str):
            kind = None
        need(kind in STAGE_TYPES, f"{path}.type must be {'|'.join(STAGE_TYPES)}")
        label(stage.get("label"), f"{path}.label")
        maximum = 200 if kind == "survive" else 24
        if need(integer(stage.get("target"), 1, maximum), f"{path}.target must be an integer 1-{maximum}"):
            stage["target"] = int(stage["target"])
        if kind == "boss":
            need(stage.get("target") == 1, f"{path}.boss target must be 1 enemy, not health")
        if kind == "drive":
            need(city_mode, f"{path}.drive requires world.city")
            need(stage.get("target") == 1, f"{path}.drive target must be 1 vehicle")
            need(number(stage.get("distanceMeters"), 20, 1500),
                 f"{path}.distanceMeters must be a number 20-1500")
            need(isinstance(stage.get("entityIds"), list) and len(stage["entityIds"]) == 1,
                 f"{path}.drive requires exactly one selected vehicle ID")
            need(not any(k in stage for k in ("propIndex", "enemyIndex", "holdSec")),
                 f"{path}.drive cannot declare ignored interaction or IP-index fields")
        elif "distanceMeters" in stage:
            need(False, f"{path}.distanceMeters is only used by drive objectives")
        if "story" in stage:
            st = stage["story"]
            if obj(st, f"{path}.story", ("speaker", "text")):
                label(st.get("speaker"), f"{path}.story.speaker", 40)
                label(st.get("text"), f"{path}.story.text", 200)
        if kind == "race":
            need(city_mode or track_mode, f"{path}.race requires world.city or world.track")
            need(integer(stage.get("target"), 1, 5), f"{path}.race target is the lap count 1-5")
            race_ids = stage.get("entityIds")
            need(isinstance(race_ids, list) and 3 <= len(race_ids) <= 16,
                 f"{path}.race requires 3-16 ordered checkpoint beacon IDs in entityIds")
            need(not any(k in stage for k in ("propIndex", "enemyIndex", "holdSec")),
                 f"{path}.race cannot declare interaction or IP-index fields")
            if "rivals" in stage:
                need(integer(stage["rivals"], 0, 5), f"{path}.rivals must be an integer 0-5")
            if "finishRank" in stage:
                need(integer(stage["finishRank"], 1, 6), f"{path}.finishRank must be an integer 1-6")
        elif any(k in stage for k in ("rivals", "vehicleId", "finishRank")):
            need(False, f"{path}.rivals/vehicleId/finishRank are only used by race objectives")
        if "vehicle" in stage:
            need(stage["vehicle"] is True and city_mode and kind in ("reach", "interact"),
                 f"{path}.vehicle is only true on a city reach/interact stage")
        if "holdSec" in stage:
            need(number(stage["holdSec"], 0, 15), f"{path}.holdSec must be a number 0-15")
            need(kind in {"reach", "interact", "talk"}, f"{path}.holdSec is only used by interaction objectives")
        if "propIndex" in stage:
            template_index(stage, "propIndex", props, path)
            need(kind in {"collect", "interact", "talk"}, f"{path}.propIndex is not used by this stage type")
        if "enemyIndex" in stage:
            template_index(stage, "enemyIndex", enemies, path)
            need(kind in {"kills", "boss"}, f"{path}.enemyIndex is not used by this stage type")
        ids = stage.get("entityIds")
        if ids is not None:
            if need(isinstance(ids, list) and 1 <= len(ids) <= 24
                    and all(isinstance(value, str) for value in ids),
                    f"{path}.entityIds must be an array of 1-24 identifiers"):
                need(len(set(ids)) == len(ids), f"{path}.entityIds must not contain duplicate targets")
                for target in ids:
                    need(target in records, f"{path}.entityIds references an unknown world entity")
        if kind == "survive":
            need(not any(k in stage for k in ("entityIds", "propIndex", "enemyIndex", "holdSec")),
                 f"{path}.survive is a timed stage and cannot declare ignored target fields")
    if errors:
        return

    def matches(stage, kind, item):
        target_types = {"prop": {"collect"}, "enemy": {"kills", "boss"}}
        if not isinstance(stage.get("type"), str) or stage["type"] not in target_types[kind]:
            return False
        if "entityIds" in stage and (not isinstance(stage["entityIds"], list) or item.get("id") not in stage["entityIds"]):
            return False
        key = "propIndex" if kind == "prop" else "enemyIndex"
        return key not in stage or stage[key] == item.get(key)

    for kind, values in (("prop", prop_placements), ("enemy", enemy_spawns)):
        for item in values:
            if not isinstance(item, dict):
                continue
            if "stageId" in item:
                stage = by_stage.get(item["stageId"]) if isinstance(item["stageId"], str) else None
                need(stage is not None, f"world entity {item.get('id')} has an unknown stageId")
                if stage:
                    allowed = {"collect", "interact", "talk"} if kind == "prop" else {"kills", "boss", "survive"}
                    need(stage.get("type") in allowed, f"world entity {item.get('id')} cannot activate for this stage type")
            else:
                first = next((stage for stage in stages if isinstance(stage, dict) and matches(stage, kind, item)), None)
                if first:
                    item["stageId"] = first["id"]

    required_positions = []
    for i, stage in enumerate(stages):
        if not isinstance(stage, dict):
            continue
        path = f"mission.stages[{i}]"
        kind = stage.get("type")
        ids = stage.get("entityIds")
        if kind == "survive":
            continue
        if kind == "race" and "vehicleId" in stage:
            need(records.get(stage["vehicleId"], ("",))[0] == "vehicle", f"{path}.vehicleId must name a city vehicle")
        if ids is None:
            if kind in {"collect", "kills", "boss"}:
                pool = prop_placements if kind == "collect" else enemy_spawns
                source_kind = "prop" if kind == "collect" else "enemy"
                candidates = [item for item in pool if isinstance(item, dict)
                              and matches(stage, source_kind, item) and item.get("stageId") == stage.get("id")]
            else:
                candidates = [item for role, item in records.values()
                              if (role in {"npc", "pedestrian"} if kind == "talk" else
                                  role in {"npc", "pedestrian"} or (role == "geometry" and (
                                      item.get("kind") == "beacon" or item.get("pickup") is True)))]
                if "propIndex" in stage:
                    candidates = [item for item in candidates if item.get("propIndex") == stage["propIndex"]]
            stage["entityIds"] = [item["id"] for item in candidates]
        elif isinstance(ids, list) and all(isinstance(value, str) for value in ids):
            candidates = [records[value][1] for value in ids if value in records]
        else:
            candidates = []
        for item in candidates:
            role = records[item["id"]][0]
            allowed = (role == "prop" if kind == "collect" else role == "enemy" if kind in {"kills", "boss"}
                       else role == "vehicle" if kind == "drive"
                       else (role == "geometry" and item.get("kind") == "beacon") if kind == "race"
                       else role in {"npc", "pedestrian"} if kind == "talk"
                       else role in {"npc", "pedestrian"} or (role == "geometry" and (
                           item.get("kind") == "beacon" or item.get("pickup") is True)))
            need(allowed, f"{path} targets must match the stage action type")
            if kind in {"collect", "kills", "boss"}:
                need(item.get("stageId") == stage.get("id"), f"{path} target is consumed or belongs to a different stage")
            for key in ("propIndex", "enemyIndex"):
                if key in stage:
                    need(item.get(key) == stage[key], f"{path} target must match its exact {key}")
            if number(item.get("x"), -half_w, half_w) and number(item.get("z"), -half_d, half_d):
                required_positions.append((item["id"], item["x"], item["z"]))
                if city:
                    need(near_street(item, city["streets"]),
                         f"mission target {item['id']} must be on a city road or sidewalk")
        if integer(stage.get("target"), 1, 200) and kind != "race":  # race target = laps
            need(stage["target"] <= len(candidates), f"{path}.target exceeds the actual eligible world entities")

    # Basic flat-world reachability on a grid of at most 10,000 cells: not a physics proof, it catches sealed rooms
    # and impossible objectives while allowing low obstacles when jumping is enabled
    if valid_spawn and not errors and required_positions:
        grid_step = max(1, world["width"] / 100, world["depth"] / 100)
        cols, rows = math.ceil(world["width"] / grid_step), math.ceil(world["depth"] / grid_step)
        jump = mechanics.get("jump", True)
        def cell(x, z):
            return (min(cols - 1, max(0, int((x + half_w) / grid_step))),
                    min(rows - 1, max(0, int((z + half_d) / grid_step))))
        start = cell(spawn["x"], spawn["z"])
        visited, pending = {start}, deque([start])
        while pending:
            x, z = pending.popleft()
            for nx, nz in ((x - 1, z), (x + 1, z), (x, z - 1), (x, z + 1)):
                if not 0 <= nx < cols or not 0 <= nz < rows or (nx, nz) in visited:
                    continue
                px, pz = (nx + .5) * grid_step - half_w, (nz + .5) * grid_step - half_d
                if abs(px) > half_w - .6 or abs(pz) > half_d - .6 or blocked(px, pz, .6, jump):
                    continue
                visited.add((nx, nz))
                pending.append((nx, nz))
        for identifier_, x, z in required_positions:
            cx, cz = cell(x, z)
            near = any((cx + dx, cz + dz) in visited for dx in (-1, 0, 1) for dz in (-1, 0, 1))
            need(near, f"mission target {identifier_} is unreachable through the authored ground layout")
