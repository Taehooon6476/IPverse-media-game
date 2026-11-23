"""Game rules on the server side: the setting a request names reaches the spec, the prompt makes the game with the
IPs already there, and placed props outside a collect stage are bonus pickups."""
import copy

import pytest

from server import gamespec, prompts
from server.tests.test_genre_modules import stair_spec

HARBOR = ("[게임 설계] 이 설계대로 3D 게임을 만들어줘.\n게임 요청: 비 내리는 네온 항구에서 볼트가 흩어진 네온 우산 3개를 모아 "
          "부두 끝 배송 지점까지 가는 짧은 수집 게임\n유형: 수집전 (경기장 곳곳의 코어 회수) [collect]")


def art(prompt, **given):
    spec = {"version": 2, "world": {"width": 60, "depth": 60}, "artDirection": dict(given)}
    return gamespec.apply_setting(spec, prompt)["artDirection"]


def test_a_rainy_night_neon_harbor_is_the_night_city_in_the_rain():
    """'비 내리는 네온 항구' is not the industrial kit (a daylight tank farm) the model may pick."""
    assert art(HARBOR, biome="industrial") == {"biome": "night-city", "timeOfDay": "night", "weather": "rain",
                                               "setting": "harbor"}


@pytest.mark.parametrize("prompt, given, want", [
    ("밤의 숲에서 비를 맞으며 반딧불을 모으는 게임", {"biome": "forest"}, {"biome": "forest", "timeOfDay": "night", "weather": "rain"}),
    ("노을 지는 사막 협곡 레이스", {"biome": "desert"}, {"biome": "desert", "timeOfDay": "dusk"}),
    ("눈보라 치는 설원에서 보급품을 찾는 게임", {"biome": "snow"}, {"biome": "snow", "weather": "snow"}),
    ("한밤의 폐허 도시를 가로지르는 탈출", {"biome": "ruins"}, {"biome": "night-city", "timeOfDay": "night"}),
    ("화창한 공장 단지 방어전", {"biome": "industrial"}, {"biome": "industrial"}),
    # words that only look like weather or night: 비밀, 비콘, 준비, 장비, 눈빛, 밤송이
    ("비밀 기지의 비콘을 켜고 장비를 준비하는 눈빛 날카로운 요원, 밤송이 수집", {"biome": "industrial"}, {"biome": "industrial"}),
    # what the agent chose itself stays
    ("비 내리는 네온 항구", {"biome": "night-city", "timeOfDay": "dusk", "weather": "clear"},
     {"biome": "night-city", "timeOfDay": "dusk", "weather": "clear", "setting": "harbor"}),
    ("지하 묘지 핵앤슬래시, 비 오는 밤", {"biome": "crypt"}, {"biome": "crypt"}),  # indoors: no sky, no rain
])
def test_the_setting_words_map_to_biome_time_and_weather(prompt, given, want):
    assert art(prompt, **given) == want


def test_a_city_world_and_a_missing_prompt_are_left_alone():
    city = {"version": 2, "world": {"city": {}}, "artDirection": {}}
    assert gamespec.apply_setting(copy.deepcopy(city), HARBOR) == city
    assert art(None, biome="industrial") == {"biome": "industrial"}


def test_make_game_writes_the_requested_setting_into_the_published_spec():
    import json
    from server import tools
    from server.tests.test_city_contract import BUCKET, authored_spec, setup_owned_assets
    ctx, session = setup_owned_assets()
    raw = authored_spec()
    raw["player"]["ipId"] = "ip_hero"
    raw["artDirection"] = {"biome": "industrial", "exposure": .9}
    result = tools.make_game(ctx, session, {"spec": raw, "_source_prompt": HARBOR})
    assert "error" not in result, result
    saved = json.loads(ctx.s3._store[(BUCKET, f"games/{result['gameId']}/spec.json")])
    assert saved["artDirection"] == {"biome": "night-city", "exposure": .9, "timeOfDay": "night", "weather": "rain",
                                     "setting": "harbor"}


def test_the_contract_carries_time_of_day_and_weather():
    spec = stair_spec()
    spec["artDirection"] = {"biome": "night-city", "timeOfDay": "night", "weather": "rain"}
    validated, errors = gamespec.validate_spec(spec)
    assert errors == [], errors
    assert validated["artDirection"]["weather"] == "rain"
    for key, bad in (("timeOfDay", "noon"), ("weather", "hail")):
        broken = stair_spec()
        broken["artDirection"] = {key: bad}
        assert any(f"artDirection.{key}" in e for e in gamespec.validate_spec(broken)[1])


def test_the_biome_rule_sends_a_night_harbor_to_the_night_city():
    [rule] = [line for line in prompts.SYSTEM.splitlines() if line.startswith("- 지정하지 않은 배경은 artDirection.biome")]
    assert "industrial(낮의" in rule and "항구" in rule.split("night-city(")[1].split(")")[0]
    [field] = [line for line in prompts.SYSTEM.splitlines() if line.startswith("- artDirection {")]
    assert "timeOfDay" in field and "weather" in field


def test_asking_for_a_game_makes_it_now_with_the_ips_there():
    """'이 IP들로 … 게임 만들어줘' calls make_game this turn: the rules do not send the agent to make more IPs first."""
    s = prompts.SYSTEM
    rule = next(line for line in s.splitlines() if line.startswith("- 게임을 만들어 달라는 요청"))
    for must in ("이번 턴에 make_game", "지금 세션에 있는 IP", "create_ip_asset", "render_3d", "묻는다"):
        assert must in rule, must
    for gone in ("이번 턴에는 make_game을 부르지 않고", "make_game은 다음 턴으로 미루고", '"지금 있는 IP로" 요청이어도'):
        assert gone not in s, gone


def test_props_outside_a_collect_stage_are_bonus_pickups():
    rule = next(line for line in prompts.SYSTEM.splitlines() if line.startswith("- 이후 단계에서 필요한 수집품"))
    assert "보너스" in rule and "heal" in rule and "shield" in rule
