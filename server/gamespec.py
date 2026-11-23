"""GameSpec validation with the existing v1 contract and bounded v2 authored worlds.

Asset references remain server-owned. Version 2 validates world placement,
ordered mission targets, mechanics and art direction through authored_contract.
"""
from __future__ import annotations
import copy
import re
from server.authored_contract import settle_sky, settle_survive, validate_authored

GENRES = ("sf-shooter", "sf-survival", "rpg-explore", "rpg-quest")
# What the studio calls each genre (web/src/types.ts GENRES), so a reply never shows the raw id
GENRE_LABELS = {"sf-shooter": "SF 슈터", "sf-survival": "SF 서바이벌", "rpg-explore": "RPG 탐험", "rpg-quest": "RPG 퀘스트"}
OBJECTIVES = {"sf": ("kills", "survive"), "rpg": ("collect", "talk")}
SHAPES = ("triangle", "circle", "square")
EFFECTS = ("heal", "score", "shield", "key")
DIFFICULTIES = ("easy", "normal", "hard")
ENGINES = ("phaser", "three")
WEAPON_TYPES = ("melee", "gun")
ANIM_URL = "assets/ual.glb"
DEFAULT_MAP = {"width": 20, "height": 15, "seed": 1234}
# three.js only (Phaser keeps the 2D contract): more SF objectives, a custom mission line, environment, rules
OBJECTIVES_3D = {"sf": ("boss", "collect", "reach"), "rpg": ()}
THEMES = ("neon-arena", "ruined-city", "desert-outpost", "ice-station", "lava-forge", "jungle-ruins")
SKIES = ("space", "day", "dusk", "storm", "night")
LAYOUTS = ("pillars", "open", "maze", "ring")
_HEX = re.compile(r"#[0-9a-fA-F]{6}")


def is_hex(v) -> bool:
    return isinstance(v, str) and _HEX.fullmatch(v) is not None  # fullmatch: "$" would allow a trailing \n


def _int(obj: dict, key: str, lo: int, hi: int) -> bool:
    """JS Number.isInteger + range. Normalizes 2.0 → 2 in place; bools are not numbers."""
    v = obj.get(key)
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi:
        obj[key] = v
        return True
    return False


def _in(v, options) -> bool:
    return isinstance(v, str) and v in options


def _url(v) -> bool:
    return v is None or (isinstance(v, str) and v != "")  # optional, else a non-empty string (like JS isUrl)


def validate_spec(spec) -> tuple:
    """Returns (normalized copy with optional fields filled, []) or (None, errors). Never mutates the input."""
    if not isinstance(spec, dict):
        return None, ["spec must be a JSON object"]
    spec = copy.deepcopy(spec)
    errors = []
    authored = spec.get("version") == 2 and not isinstance(spec.get("version"), bool)

    def need(ok, message):
        if not ok:
            errors.append(message)

    family = spec["genre"].split("-")[0] if _in(spec.get("genre"), GENRES) else None

    # Keep v1's normalization and error messages for existing published games.
    need(_int(spec, "version", 2, 2) if authored else _int(spec, "version", 1, 1),
         "version must be 2" if authored else "version must be 1")
    need(family, f"genre must be one of {'|'.join(GENRES)}")
    need(spec.get("engine") is None or _in(spec.get("engine"), ENGINES), f"engine must be {'|'.join(ENGINES)}")
    if authored:
        need(spec.get("engine") == "three", "version 2 requires engine three")
    need(_url(spec.get("animUrl")), "animUrl must be a non-empty string")

    palette = spec.get("palette")
    if not isinstance(palette, dict):
        errors.append("palette must be an object with bg, accent, text")
    else:
        for key in ("bg", "accent", "text"):
            need(is_hex(palette.get(key)), f"palette.{key} must be a #rrggbb hex color")

    player = spec.get("player")
    if not isinstance(player, dict):
        errors.append("player must be an object")
    else:
        need(_int(player, "speed", 1, 3), "player.speed must be an integer 1-3")
        need(_url(player.get("modelUrl")), "player.modelUrl must be a non-empty string")
        need(_url(player.get("weaponUrl")), "player.weaponUrl must be a non-empty string")
        need(player.get("weaponType") is None or _in(player.get("weaponType"), WEAPON_TYPES),
             f"player.weaponType must be {'|'.join(WEAPON_TYPES)}")

    objective = spec.get("objective")
    if not isinstance(objective, dict):
        errors.append("objective must be an object")
    else:
        if family:
            types = (("kills", "survive", "boss", "collect", "reach", "talk", "interact") if authored
                     else OBJECTIVES[family] + (() if spec.get("engine") == "phaser" else OBJECTIVES_3D[family]))
            if authored and isinstance(spec.get("world"), dict) and "city" in spec["world"]:
                types += ("drive",)
            need(_in(objective.get("type"), types), f"objective.type must be {'|'.join(types)} for {spec['genre']}")
            if objective.get("type") == "drive":
                need(objective.get("target") == 1, "objective.drive target must be 1 vehicle")
        need(_int(objective, "target", 1, 200), "objective.target must be an integer 1-200")
        label = objective.get("label")
        need(label is None or (isinstance(label, str) and len(label) <= 60),
             "objective.label must be a string of at most 60 characters")

    env = spec.get("environment")
    if env is not None:
        if not isinstance(env, dict):
            errors.append("environment must be an object")
        else:
            if authored:
                need(not set(env) - {"theme", "sky", "layout", "size", "obstacles"},
                     "environment contains unsupported fields")
            need(env.get("theme") is None or _in(env.get("theme"), THEMES), f"environment.theme must be {'|'.join(THEMES)}")
            need(env.get("sky") is None or _in(env.get("sky"), SKIES), f"environment.sky must be {'|'.join(SKIES)}")
            need(env.get("layout") is None or _in(env.get("layout"), LAYOUTS),
                 f"environment.layout must be {'|'.join(LAYOUTS)}")
            need(env.get("size") is None or _int(env, "size", 18, 45), "environment.size must be an integer 18-45")
            need(env.get("obstacles") is None or _int(env, "obstacles", 0, 30),
                 "environment.obstacles must be an integer 0-30")
    rules = spec.get("rules")
    if rules is not None:
        if not isinstance(rules, dict):
            errors.append("rules must be an object")
        else:
            need(rules.get("timeLimitSec") is None or _int(rules, "timeLimitSec", 0, 900),
                 "rules.timeLimitSec must be an integer 0-900")
            rate = rules.get("enemyRate")
            need(rate is None or (isinstance(rate, (int, float)) and not isinstance(rate, bool) and 0.25 <= rate <= 3),
                 "rules.enemyRate must be a number 0.25-3")
            need(rules.get("playerHp") is None or _int(rules, "playerHp", 50, 500),
                 "rules.playerHp must be an integer 50-500")

    need(_in(spec.get("difficulty"), DIFFICULTIES), f"difficulty must be {'|'.join(DIFFICULTIES)}")

    if spec.get("enemies") is None and (family == "rpg" or authored):
        spec["enemies"] = []
    min_enemies = 0 if family == "rpg" or authored else 1
    enemies = spec.get("enemies")
    if not isinstance(enemies, list) or not min_enemies <= len(enemies) <= 5:
        errors.append(f"enemies must be an array of {min_enemies}-5 items")
    else:
        for i, enemy in enumerate(enemies):
            if not isinstance(enemy, dict):
                errors.append(f"enemies[{i}] must be an object")
                continue
            need(is_hex(enemy.get("color")), f"enemies[{i}].color must be a #rrggbb hex color")
            need(_in(enemy.get("shape"), SHAPES), f"enemies[{i}].shape must be {'|'.join(SHAPES)}")
            need(_int(enemy, "speed", 1, 3), f"enemies[{i}].speed must be an integer 1-3")
            need(_int(enemy, "hp", 1, 3), f"enemies[{i}].hp must be an integer 1-3")
            need(_url(enemy.get("modelUrl")), f"enemies[{i}].modelUrl must be a non-empty string")
            need(_url(enemy.get("weaponUrl")), f"enemies[{i}].weaponUrl must be a non-empty string")
            need(enemy.get("humanoid") is None or isinstance(enemy.get("humanoid"), bool),
                 f"enemies[{i}].humanoid must be a boolean")

    if spec.get("props") is None:
        spec["props"] = []
    if not isinstance(spec["props"], list):
        errors.append("props must be an array")
    else:
        for i, prop in enumerate(spec["props"]):
            if not isinstance(prop, dict):
                errors.append(f"props[{i}] must be an object")
                continue
            need(_in(prop.get("effect"), EFFECTS), f"props[{i}].effect must be {'|'.join(EFFECTS)}")
            need(_url(prop.get("modelUrl")), f"props[{i}].modelUrl must be a non-empty string")

    if spec.get("dialogue") is None:
        spec["dialogue"] = []
    dialogue = spec["dialogue"]
    if not isinstance(dialogue, list) or len(dialogue) > 12:
        errors.append("dialogue must be an array of 0-12 lines")
    else:
        for i, line in enumerate(dialogue):  # len() counts code points, like [...text].length in JS
            need(isinstance(line, dict) and isinstance(line.get("text"), str) and len(line["text"]) <= 140,
                 f"dialogue[{i}].text must be a string of at most 140 characters")

    spec.setdefault("quest", None)  # JS fills only when absent (undefined), keeps an explicit null
    need(spec["quest"] is None or isinstance(spec["quest"], dict), "quest must be an object or null")

    if spec.get("map") is None and family == "rpg":
        spec["map"] = dict(DEFAULT_MAP)
    if spec.get("map") is not None:
        game_map = spec["map"]
        if not isinstance(game_map, dict):
            errors.append("map must be an object")
        else:
            need(_int(game_map, "width", 12, 30), "map.width must be an integer 12-30")
            need(_int(game_map, "height", 9, 20), "map.height must be an integer 9-20")

    if authored and not errors:
        validate_authored(spec, errors)
    return (None, errors) if errors else (spec, [])


def cast_errors(spec: dict, cast: list, ips_by_id: dict) -> list:
    """The user picked which IPs appear (the design drawer's 출연 IP): the player, every enemy and prop must be one of
    them (no procedural stand-ins), weapons too, and every picked IP must be used somewhere. → error strings."""
    errors = []
    unknown = [i for i in cast if i not in ips_by_id]
    if unknown:
        return [f"cast_ip_ids에 없는 ipId: {', '.join(unknown)}"]
    allowed, used = set(cast), set()
    slots = [("player", spec.get("player"))] + [(f"enemies[{n}]", e) for n, e in enumerate(spec.get("enemies") or [])] \
        + [(f"props[{n}]", p) for n, p in enumerate(spec.get("props") or [])]
    background = (spec.get("world") or {}).get("background") if spec.get("version") == 2 else None
    if isinstance(background, dict):
        slots.append(("world.background", background))
    if spec.get("version") == 2:
        slots += [(f"world.entities[{n}]", e) for n, e in enumerate((spec.get("world") or {}).get("entities") or [])
                  if isinstance(e, dict) and e.get("kind") == "model"]
    for where, entity in slots:
        if not isinstance(entity, dict):
            continue
        ip_id = entity.get("ipId")
        if ip_id not in allowed:
            errors.append(f"{where}.ipId는 출연 IP 중 하나여야 합니다 (지금: {ip_id or '없음'})")
        used.add(ip_id)
        wid = entity.get("weaponIpId")
        if wid is not None:
            if wid not in allowed:
                errors.append(f"{where}.weaponIpId는 출연 IP 중 하나여야 합니다 (지금: {wid})")
            used.add(wid)
    missing = [f"{ips_by_id[i].get('name', i)}({i})" for i in cast if i not in used]
    if missing:
        errors.append("출연 IP를 모두 게임에 넣어야 합니다. 빠진 IP: " + ", ".join(missing))
    return errors


def resolve_sprites(spec: dict, ips_by_id: dict, glb_ip_ids=(), rig_ip_ids=()) -> dict:
    """Server-owned asset URLs, relative to the game folder. Known IPs get `assets/{ipId}.png` (player, props). IPs in
    `glb_ip_ids` (three.js games only) get `assets/{ipId}.glb` as modelUrl, or `assets/{ipId}.rig.glb` when the player
    or a humanoid enemy is also in `rig_ip_ids`. V2 props assigned to the guide/pedestrian NPC role also prefer a rig
    when their IP is a character or humanoid enemy; other props keep their raw model. `weaponIpId` on the player or
    an enemy becomes weaponUrl (+ the player's weaponType). Enemies with an IP get its model and `humanoid`; any
    rigged model adds `animUrl`. Model-sent URLs are dropped; unknown ipIds get none."""
    spec = copy.deepcopy(spec)

    def model_url(ip_id, rigged_ok):
        if ip_id in rig_ip_ids and rigged_ok:
            return f"assets/{ip_id}.rig.glb"
        return f"assets/{ip_id}.glb" if ip_id in glb_ip_ids else None

    def known(ip_id):
        return isinstance(ip_id, str) and ip_id in ips_by_id

    def weapon(entity):
        entity.pop("weaponUrl", None)
        entity.pop("weaponType", None)
        wid = entity.get("weaponIpId")
        if known(wid) and ips_by_id[wid].get("kind") == "weapon" and wid in glb_ip_ids:
            entity["weaponUrl"] = f"assets/{wid}.glb"
            return ips_by_id[wid].get("weaponType") or "melee"
        return None

    player = spec.get("player")
    props = list(spec.get("props") or [])
    npc_indices = set()
    world = spec.get("world")
    if spec.get("version") == 2 and isinstance(world, dict):
        npc = world.get("npc")
        city = world.get("city")
        pedestrians = city.get("pedestrians") if isinstance(city, dict) else []
        for role in [npc, *(pedestrians if isinstance(pedestrians, list) else [])]:
            index = role.get("propIndex") if isinstance(role, dict) else None
            if isinstance(index, int) and not isinstance(index, bool) and 0 <= index < len(props):
                npc_indices.add(index)
    for index, entity in enumerate([player, *props]):
        if not isinstance(entity, dict):
            continue
        entity.pop("spriteUrl", None)
        entity.pop("modelUrl", None)
        ip_id = entity.get("ipId")
        if known(ip_id):
            entity["spriteUrl"] = f"assets/{ip_id}.png"
            ip = ips_by_id[ip_id]
            npc_rig = (index - 1 in npc_indices and
                       (ip.get("kind") == "character"
                        or (ip.get("kind") == "enemy" and ip.get("humanoid", True))))
            url = model_url(ip_id, entity is player or npc_rig)
            if url:
                entity["modelUrl"] = url
    if isinstance(player, dict):
        weapon_type = weapon(player)
        if weapon_type:
            player["weaponType"] = weapon_type
    for enemy in spec.get("enemies") or []:
        if not isinstance(enemy, dict):
            continue
        for key in ("modelUrl", "humanoid", *(("spriteUrl",) if spec.get("version") == 2 else ())):
            enemy.pop(key, None)
        weapon(enemy)
        ip_id = enemy.get("ipId")
        if known(ip_id):
            ip = ips_by_id[ip_id]
            if spec.get("version") == 2:
                enemy["spriteUrl"] = f"assets/{ip_id}.png"
            enemy["humanoid"] = ip.get("kind") == "character" or (ip.get("kind") == "enemy" and ip.get("humanoid", True))
            url = model_url(ip_id, enemy["humanoid"])
            if url:
                enemy["modelUrl"] = url
    spec.pop("animUrl", None)
    if any(isinstance(e, dict) and str(e.get("modelUrl", "")).endswith(".rig.glb")
           for e in [player, *props, *(spec.get("enemies") or [])]):
        spec["animUrl"] = ANIM_URL
    if spec.get("version") == 2 and isinstance(world, dict) and isinstance(world.get("background"), dict):
        background = world["background"]
        background.pop("imageUrl", None)
        background.pop("modelUrl", None)
        ip_id = background.get("ipId")
        if known(ip_id) and ips_by_id[ip_id].get("kind") == "prop":
            ip = ips_by_id[ip_id]
            if background.get("mode") == "image" and ip.get("imageAssetId"):
                background["imageUrl"] = f"assets/{ip_id}.background.png"
            elif background.get("mode") == "model" and ip.get("glbAssetId") and ip_id in glb_ip_ids:
                background["modelUrl"] = f"assets/{ip_id}.background.glb"
    if spec.get("version") == 2 and isinstance(world, dict):
        # Set pieces: the prop IP's raw 3D model, else its cutout standing as a panel with the entity's collider.
        # A race car body (car) needs the model.
        for entity in world.get("entities") or []:
            if isinstance(entity, dict) and entity.get("kind") == "model":
                entity.pop("modelUrl", None)
                entity.pop("spriteUrl", None)
                ip_id = entity.get("ipId")
                prop = ips_by_id[ip_id] if known(ip_id) and ips_by_id[ip_id].get("kind") == "prop" else None
                if prop and prop.get("glbAssetId") and ip_id in glb_ip_ids:
                    entity["modelUrl"] = f"assets/{ip_id}.set.glb"
                elif prop and prop.get("cutoutAssetId") and "car" not in entity:
                    entity["spriteUrl"] = f"assets/{ip_id}.png"
    return spec


# The setting a request names: night, dusk, rain and snow words in the user's request become artDirection.timeOfDay /
# weather, and a night street or harbor in a daylight urban kit becomes the night city. What the agent set itself
# stays; indoors stays dry.
_HANGUL_BEFORE = r"(?<![가-힣])"
_NIGHT = re.compile(r"밤(?!송이|나무|색|새)|야경|야간|심야|자정|네온|\bnight|midnight|neon", re.I)
_DUSK = re.compile(r"노을|해\s*질\s*녘|황혼|석양|저녁|\bdusk|sunset|twilight", re.I)
_RAIN = re.compile(_HANGUL_BEFORE + r"비\s*(?:가|를|내리|오|와|쏟|맞)|빗(?:속|길|방울|줄기|물|소리)|폭우|장대비|소나기|우천|장마|\brain",
                   re.I)
_SNOW = re.compile(_HANGUL_BEFORE + r"눈\s*(?:이|내리|오|와|송이|발)|함박눈|폭설|눈보라|blizzard|snowfall|snowing|snowstorm"
                   r"|\bsnowy\b|\bfalling snow\b|\bin the snow\b", re.I)
_URBAN = re.compile(r"도시|거리|골목|항구|항만|부두|시내|harbou?r|\bport\b|\bdocks?\b|street|city|downtown", re.I)
_DAYLIGHT_URBAN = ("industrial", "ruins")  # photographed by day: at night they are the night city
# A harbor the request names is artDirection.setting "harbor": the runtime lays water past one edge, a quay, cranes
# and container stacks (game3d/biome.js harborPlan).
_HARBOR = re.compile(r"항구|항만|부두|부둣가|선착장|harbou?r|\bports?\b|\bdocks?\b|\bpiers?\b|wharf|quay", re.I)

# Sky islands are artDirection.setting "sky": no floor, a cloud sea far below, a fall respawns (game3d/sky.js). The
# game's own title counts too: a remake's request may name no place.
_SKY = re.compile(r"(?:하늘|공중|부유|구름)\s*섬(?!유)|떠\s*(?:있는|다니는)\s*섬|구름\s*위(?!로\s*솟)|천공\s*(?:섬|도시)"
                  r"|floating\s+islands?|sky[\s-]*islands?|islands?\s+in\s+the\s+sky|above\s+the\s+clouds|sky\s+realm", re.I)


# What a survive game's request may name for itself (authored_contract.settle_survive keeps it): an automatic attack,
# unless the words right after it (or, in English, right before it) turn it off, and the hero's HP as a number.
_AUTO_ASKED = re.compile(r"(?:자동|오토)\s*(?:으로\s*)?(?:공격|사격|조준|발사|전투|에임|파이어|쏘|싸우)|auto[\s-]?(?:fire|attack|aim|shoot|battle)"
                         r"|\bautomatic(?:ally)?\s+(?:fir|attack|aim|shoot|target)\w*"
                         r"|\b(?:fires?|attacks?|shoots?|aims?)\s+(?:\w+\s+){0,2}?(?:automatically|by itself|on its own)\b"
                         r"|뱀서|뱀파이어\s*서바이벌|vampire\s*survivors", re.I)
_TURNED_OFF = re.compile(r"\s*(?:은|는|을|를|이|가|도)?\s*(?:기능\s*(?:은|는|을|를)?\s*)?(?:하지\s*)?"
                         r"(?:끄|꺼|없|말고|말아|빼|해제|금지|(?:(?:is|should be|must be|stays?|should stay|turned|switched)\s+)?"
                         r"(?:off|disabled)\b)", re.I)
_NOT_BEFORE = re.compile(r"(?:\bno|\bwithout|\bdisable|\bturn off|\bswitch off|\bnever|\bdon'?t|\bdo not)\s+(?:the\s+|any\s+|use\s+)?$", re.I)
# A share of the bar ("체력이 50% 이하면…") is not an HP the user named for the hero
_HP_ASKED = re.compile(r"(?:체력|생명력|피통|\bHP|\bhealth|\bhit\s*points)\s*(?:은|는|을|를|이|가|:|=|of|to|at|is)?\s*\d{2,4}"
                       r"(?!\d|\s*(?:%|％|퍼센트|프로|percent))"
                       r"|(?<![\d.])\d{2,4}\s*(?:HP|health|hit\s*points)\b", re.I)
# The line the page puts before an edit of a game or its re-make with new 3D (web/src/api.ts rebuildRequest,
# GameEditDrawer.tsx), after the chat box's own model tags when the line was sent from there (ChatDock.tsx withModels)
_REVISES = re.compile(r"\s*(?:\[(?:이미지|영상) 모델: [^\]]*\]\s*)*\[게임 수정 gameId=([^\]\s]+)\]")


def revises(prompt):
    """The gameId a request says it revises (its "[게임 수정 gameId=…]" line), else None: such a request is a
    revision even when the model sends no base_game_id."""
    marked = _REVISES.match(prompt) if isinstance(prompt, str) else None
    return marked[1] if marked else None


def apply_survive(spec: dict, prompt, revision: bool = False) -> list:
    """A survive stage an idle hero cannot clear (authored_contract.settle_survive), with what the request names for
    itself left alone. A revision of a game (make_game's base_game_id, or the request's own line: revises) keeps the
    numbers it is sent with: they are the user's own tuning by now.
    → what the server changed, for make_game's result."""
    if spec.get("version") != 2:
        return []
    revision = revision or bool(revises(prompt))
    prompt = prompt if isinstance(prompt, str) else ""
    auto = any(not _TURNED_OFF.match(prompt, m.end()) and not _NOT_BEFORE.search(prompt[:m.start()])
               for m in _AUTO_ASKED.finditer(prompt))
    return settle_survive(spec, tune=not revision, keep_hp=bool(_HP_ASKED.search(prompt)), keep_auto=auto)


def _named_text(spec, prompt):
    titles = [spec.get("title"), (spec.get("mission") or {}).get("title") if isinstance(spec.get("mission"), dict) else None]
    return " ".join(t for t in [prompt, *titles] if isinstance(t, str))


def apply_setting(spec: dict, prompt) -> dict:
    """artDirection from the request's own words (see above). City worlds keep their environment.sky. → spec"""
    world = spec.get("world") or {}
    if spec.get("version") != 2 or "city" in world:
        return spec
    # A remake the agent starts itself has no request text: the game's own title and mission still name the place
    prompt = prompt if isinstance(prompt, str) else ""
    art = spec.setdefault("artDirection", {})
    if art.get("biome") == "crypt":
        return spec
    night, neon = _NIGHT.search(prompt), re.search(r"네온|neon", prompt, re.I)
    if night and art.get("biome") in _DAYLIGHT_URBAN and (neon or _URBAN.search(prompt)):
        art["biome"] = "night-city"
    if "timeOfDay" not in art and (night or _DUSK.search(prompt)):
        art["timeOfDay"] = "night" if night else "dusk"
    if "weather" not in art and (_RAIN.search(prompt) or _SNOW.search(prompt)):
        art["weather"] = "rain" if _RAIN.search(prompt) else "snow"
    if "setting" not in art and _SKY.search(_named_text(spec, prompt)):  # before a harbor: an airship dock in the sky
        art["setting"] = "sky"
        settle_sky(spec)
    if "setting" not in art and _HARBOR.search(prompt):
        art["setting"] = "harbor"
    return spec
