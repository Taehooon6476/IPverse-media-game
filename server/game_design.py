"""User-authored design and cast constraints, kept independently of model output."""
from __future__ import annotations

import copy
import re
from server.i18n import tr

ROLE_FIELDS = ("propIpIds", "enemyIpIds", "npcIpIds", "setIpIds")  # setIpIds: 배경 사물, kind-model world entities
MAX_IPS = 24
MAX_PROMPT = 4000


# What validate_design answers is the toast of the 게임 설계 drawer (app.chat joins the sentences): written for the
# person who filled it, in the drawer's own words for the roles (web/src/components/DesignDrawer.tsx GAME_ROLE_LABEL).
# A sentence is said once, however many fields it is true of. role_errors below is the agent's copy instead.
NOT_HERE = "고른 IP 중에 이 세션에 없는 것이 있어요. 게임 설계 창에서 출연 IP를 다시 골라 주세요."


def validate_design(value, ips: dict, prompt: str) -> tuple:
    if not isinstance(value, dict):
        return None, [tr("게임 설계를 읽지 못했어요. 게임 설계 창을 닫았다가 다시 열어 주세요.")]
    errors = []
    source = value.get("prompt")
    if not isinstance(source, str) or not source.strip() or len(source) > MAX_PROMPT:
        errors.append(tr("게임 아이디어를 {limit}자 안으로 적어 주세요.", limit=f"{MAX_PROMPT:,}"))
    elif source != prompt:
        errors.append(tr("게임 설계와 보낸 메시지가 서로 달라요. 게임 설계 창에서 다시 보내 주세요."))
    design = {"prompt": source}
    for key in ("castIpIds", *ROLE_FIELDS):
        ids = value.get(key, [])
        if isinstance(ids, list) and len(ids) > MAX_IPS:
            errors.append(tr("IP는 한 역할에 {n}개까지 고를 수 있어요.", n=MAX_IPS))
            ids = []
        elif not isinstance(ids, list) or not all(isinstance(i, str) and i in ips for i in ids):
            errors.append(tr(NOT_HERE))
            ids = []
        if len(ids) != len(set(ids)):
            errors.append(tr("같은 IP가 한 역할에 두 번 들어 있어요. 출연 IP를 다시 골라 주세요."))
        design[key] = ids
    if "setIpIds" not in value:  # optional role: absent stays absent (older requests compare equal)
        design.pop("setIpIds")
    for key in ("playerIpId", "weaponIpId"):
        ip_id = value.get(key)
        if ip_id is not None and (not isinstance(ip_id, str) or ip_id not in ips):
            errors.append(tr(NOT_HERE))
        design[key] = ip_id
    if "backgroundIpId" in value:
        ip_id = value["backgroundIpId"]
        if ip_id is not None and (not isinstance(ip_id, str) or ip_id not in ips):
            errors.append(tr(NOT_HERE))
            ip_id = None
        design["backgroundIpId"] = ip_id
    if len(design["npcIpIds"]) > 1:
        errors.append(tr("NPC·동료는 1명까지 고를 수 있어요."))
    cast = set(design["castIpIds"])
    assigned = [i for i in (design["playerIpId"], design["weaponIpId"], design.get("backgroundIpId"))
                if i is not None]
    assigned += [i for field in ROLE_FIELDS for i in design.get(field, [])]
    if cast:
        if not design["playerIpId"]:
            errors.append(tr("주인공을 하나 골라 주세요."))
        if set(assigned) != cast:
            errors.append(tr("고른 IP마다 역할을 하나씩 정해 주세요."))
        if len(assigned) != len(set(assigned)):
            errors.append(tr("한 IP에는 역할을 하나만 줄 수 있어요."))
    elif assigned:
        errors.append(tr("역할을 준 IP를 출연 IP로도 골라 주세요."))
    # The hero is what make_game's 3D rule takes (tools.game_heroes): any IP that can stand in a game, never a scene
    player = ips.get(design["playerIpId"])
    if player and player.get("usage") == "background":
        errors.append(tr("배경(장면 전체)은 주인공이 될 수 없어요. 다른 IP를 주인공으로 골라 주세요."))
    weapon = ips.get(design["weaponIpId"])
    if weapon and weapon.get("kind") != "weapon":
        errors.append(tr("주인공 무기는 무기 IP 중에서 골라 주세요."))
    background = ips.get(design.get("backgroundIpId"))
    if background and background.get("kind") != "prop":
        errors.append(tr("배경·환경은 소품 IP 중에서 골라 주세요."))
    if any(ips[i].get("kind") != "prop" for i in design.get("setIpIds", [])):
        errors.append(tr("배경 사물은 소품 IP 중에서 골라 주세요."))
    return (None, list(dict.fromkeys(errors))) if errors else (design, [])


def for_turn(messages: list, pending_id: str):
    """Only the last user message preceding this turn can constrain it; old designs do not leak into new requests."""
    preceding = []
    for message in messages:
        if message["messageId"] == pending_id:
            break
        preceding.append(message)
    user = next((m for m in reversed(preceding) if m.get("role") == "user"), None)
    if not user:
        return None
    if user.get("gameDesign"):
        return copy.deepcopy(user["gameDesign"])
    # Existing clients put explicit selections in a tag. Preserve these restrictions too.
    tag = re.search(r"\[출연 IP cast_ip_ids=([^\]\s]+)\]", user.get("text", ""))
    if tag:
        return {"prompt": user["text"], "castIpIds": list(dict.fromkeys(tag[1].split(","))),
                "playerIpId": None, "weaponIpId": None,
                "propIpIds": [], "enemyIpIds": [], "npcIpIds": []}
    return None


def role_errors(spec: dict, design: dict) -> list:
    """Reject changed player/weapon roles and ensure selected roles are used in the playable scene."""
    errors = []
    player = spec.get("player") or {}
    if design.get("playerIpId") and player.get("ipId") != design["playerIpId"]:
        errors.append("player.ipId must match the user's selected playerIpId")
    if design.get("weaponIpId") and player.get("weaponIpId") != design["weaponIpId"]:
        errors.append("player.weaponIpId must match the user's selected weaponIpId")
    background_id = design.get("backgroundIpId")
    if background_id:
        background = (spec.get("world") or {}).get("background") or {}
        if background.get("ipId") != background_id:
            errors.append("world.background.ipId must match the user's selected backgroundIpId")
        if any(e.get("ipId") == background_id or e.get("weaponIpId") == background_id
               for e in [player, *(spec.get("props") or []), *(spec.get("enemies") or [])]):
            errors.append("The selected background must use its separate environment slot, not another role")
    for field, slot in (("propIpIds", "props"), ("enemyIpIds", "enemies")):
        actual = {e.get("ipId") for e in spec.get(slot, [])}
        for ip_id in design.get(field, []):
            if ip_id not in actual:
                errors.append(f"{field}: {ip_id} is missing from {slot}")
    set_ids = set(design.get("setIpIds") or [])
    placed = {e.get("ipId") for e in (spec.get("world") or {}).get("entities") or [] if e.get("kind") == "model"}
    for ip_id in sorted(set_ids - placed):
        errors.append(f"setIpIds: {ip_id} must be placed as a world entity of kind model")
    for ip_id in sorted(placed - set_ids):
        errors.append(f"world.entities: {ip_id} is not one of the user's set pieces (setIpIds)")
    npc_ip_ids = design.get("npcIpIds") or []
    npc = (spec.get("world") or {}).get("npc") or {}
    npc_index = npc.get("propIndex")
    props = spec.get("props") or []
    npc_ip_id = props[npc_index].get("ipId") if isinstance(npc_index, int) and 0 <= npc_index < len(props) else None
    for ip_id in npc_ip_ids:
        if npc_ip_id != ip_id:
            errors.append(f"npcIpIds: {ip_id} must appear as world.npc using its propIndex")
    # A selected ally cannot silently become an enemy, or an item become a combatant.
    designated_enemies = set(design.get("enemyIpIds") or [])
    protected = {design.get("playerIpId"), *(design.get("propIpIds") or []), *npc_ip_ids}
    for enemy in spec.get("enemies") or []:
        if enemy.get("ipId") in protected - designated_enemies:
            errors.append("A selected player, prop, or NPC cannot be used as an enemy")
    return errors


def provenance(design: dict) -> dict:
    return {"sourcePrompt": design["prompt"],
            **{key: copy.deepcopy(design.get(key)) for key in
               ("castIpIds", "playerIpId", "weaponIpId", *ROLE_FIELDS) if key != "setIpIds" or key in design},
            **({"backgroundIpId": design["backgroundIpId"]} if "backgroundIpId" in design else {})}
