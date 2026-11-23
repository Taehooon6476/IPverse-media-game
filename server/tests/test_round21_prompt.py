"""Prompt rules checked on the prompt's own text (no model is called): a line from the edit drawer that is no edit
(another person, one more figure) is asked about before any tool is called. The rule is the prompt's: the server adds
no classifier of its own."""
from server import prompts


def _rule(lead: str) -> str:
    """The prompt's line that starts with these words."""
    return next(line for line in prompts.SYSTEM.splitlines() if line.lstrip("- ").startswith(lead))


def test_a_line_from_the_edit_drawer_that_is_no_edit_is_asked_about_first():
    rule = _rule('"[에셋 수정 ipId=…]"로 시작하는 메시지는')
    # what the drawer is for, in one line the reply can say
    assert "수정하기 창에서 보낸 것" in rule and "한 부분만 바꾸는 일" in rule
    # the two kinds of request, by what they ask and with an example each
    assert "다른 인물이나 다른 물체로 바꿔 달라는 요청" in rule and '"완전히 다른 사람으로 바꿔줘"' in rule
    assert "하나 더 그려 넣어 달라는 요청" in rule and '"옆에 쌍둥이를 한 명 더 그려 넣어줘"' in rule
    # no tool in their place, neither the edit nor a redraw nor a new IP
    assert "도구를 부르지 않는다" in rule
    for tool in ("make_ip_variant", "reroll_ip_image", "create_ip_asset"):
        assert tool in rule, tool
    # the reply says what an edit can do and offers the right way as a question; the tool comes with the answer
    assert "수정으로 할 수 있는 일을 한 줄로 말하고" in rule and "질문으로 권한다" in rule
    assert "새로 그릴까요" in rule and "새 캐릭터를 따로 만들까요" in rule
    assert "사용자가 고르면 그때" in rule
    # it is the stated exception to "call a tool rather than ask"
    assert "질문하기보다 도구를 호출한다는 규칙의 예외" in rule
    assert prompts.SYSTEM.count("질문하기보다 도구를 호출한다") == 2  # the rule and this exception to it


def test_an_edit_that_is_one_is_still_made_at_once():
    """The drawer's ordinary line: one part changed, no question."""
    variant = _rule("make_ip_variant:")
    assert '"[에셋 수정 ipId=…]"로 시작하는 메시지에 쓴다' in variant
    assert "아래 규칙" in variant  # ... and points at the rule for a line that is no edit
