"""A harbor the request names becomes artDirection.setting "harbor" (water, a quay, cranes and container stacks in
game3d/biome.js), and the game rules say so."""
import pytest

from server import gamespec, prompts
from server.tests.test_round9_games import HARBOR, art


def test_the_rainy_neon_harbor_is_a_harbor_at_night_in_the_rain():
    """Biome, night and rain alone do not read as a harbor: the setting adds the water and the dock."""
    assert art(HARBOR, biome="industrial") == {"biome": "night-city", "timeOfDay": "night", "weather": "rain",
                                               "setting": "harbor"}


@pytest.mark.parametrize("prompt", ["항만 컨테이너 터미널 잠입", "부둣가 추격전", "선착장에서 보물 찾기", "a harbour heist",
                                    "night at the docks", "port of call", "항구 도시의 밤"])
def test_harbor_words_make_a_harbor(prompt):
    assert art(prompt, biome="industrial").get("setting") == "harbor"


@pytest.mark.parametrize("prompt, given", [
    ("화창한 공장 단지 방어전", {"biome": "industrial"}),
    ("항구 지하 묘지 탐험", {"biome": "crypt"}),  # indoors: no water
    ("하늘 신전의 비밀 항로", {"biome": "temple"}),  # 항로 is not a harbor
    ("passport photo shooter", {"biome": "industrial"}),
])
def test_no_harbor_without_a_harbor(prompt, given):
    assert "setting" not in art(prompt, **given)


def test_the_contract_accepts_the_harbor_setting_the_agent_may_copy_from_an_old_spec():
    """apply_setting adds artDirection.setting after validation; a spec that already carries it (an agent copying the
    published one) must still validate, and an unknown setting must not."""
    from server.tests.test_genre_modules import stair_spec
    spec = stair_spec()
    spec["artDirection"] = {"biome": "night-city", "timeOfDay": "night", "weather": "rain", "setting": "harbor"}
    validated, errors = gamespec.validate_spec(spec)
    assert errors == [], errors
    assert validated["artDirection"]["setting"] == "harbor"
    broken = stair_spec()
    broken["artDirection"] = {"setting": "moonbase"}
    assert any("artDirection.setting" in e for e in gamespec.validate_spec(broken)[1])


def test_the_game_rules_describe_the_harbor_setting():
    harbor = [line for line in prompts.SYSTEM.splitlines() if "크레인" in line]
    assert harbor and "항구" in harbor[0] and "물" in harbor[0]
