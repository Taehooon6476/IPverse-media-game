"""The agent's prompt describes the screen there is, states the times the cards state, and asks for a reply a
first-time user can read: short, in 해요체, with no ids, hex colours, tool or service names."""
import pathlib
import re

from server import agent, prompts, tools, waits

WEB = pathlib.Path(__file__).resolve().parents[2] / "web" / "src"


def _section(title: str) -> str:
    """One "## title …" section of the prompt, without the next one."""
    start = prompts.SYSTEM.index(f"## {title}")
    end = prompts.SYSTEM.find("\n## ", start + 3)
    return prompts.SYSTEM[start:end if end > 0 else None]


def _agent_copy() -> str:
    """Everything the agent reads ahead of a result: the prompt and every tool description."""
    def descs(obj):
        if isinstance(obj, dict):
            for key, value in obj.items():
                if key == "description" and isinstance(value, str):
                    yield value
                else:
                    yield from descs(value)
        elif isinstance(obj, list):
            for value in obj:
                yield from descs(value)
    return "\n".join([prompts.SYSTEM, *(d for spec in tools.TOOL_SPECS for d in descs(spec))])


# ── the screen ─────────────────────────────────────────────────────────────────

def test_the_screen_the_prompt_describes_is_the_one_the_components_draw():
    """Every name the 화면 section quotes is a label in web/src today: a tab, a button, a fold, a menu row."""
    screen = _section("화면")
    web = "\n".join(p.read_text(encoding="utf-8") for p in sorted(WEB.rglob("*.tsx")) if ".test." not in p.name)
    quoted = re.findall(r"'([^']+)'", screen)
    assert len(quoted) >= 30, quoted
    # the sidebar's fold may still carry its older title in the web
    renamed = {"스킬 · 에이전트": "스킬 · Agent 등록"}
    missing = [name for name in dict.fromkeys(quoted) if name not in web and renamed.get(name, name) not in web]
    assert missing == [], missing
    for name in ("작업 현황", "게시하기", "장르 스킬", "스킬 · 에이전트", "라이브 방송", "크게 보기", "게임 설계",
                 "게임 설정", "미리보기", "설계 요약", "버전 기록", "3D로 만들기", "라이브 켜기", "라이브 끄기"):
        assert f"'{name}'" in screen, name


def test_the_screen_that_is_gone_is_not_described():
    s = prompts.SYSTEM
    for gone in ("파이프라인 작업 목록", "좌측 Skills 탭", "오른쪽 게임 영역: GameSpec"):
        assert gone not in s, gone
    assert "게임을 배포한다" not in _agent_copy()  # the button says 게시하기
    # where each thing is now
    screen = _section("화면")
    assert re.search(r"IP 영역[^\n]*탭 다섯", screen) and "'작업 현황' 탭" in screen
    assert re.search(r"맨 위 줄[^\n]*'게시하기'", screen)
    assert re.search(r"사이드바[^\n]*'스킬 · 에이전트'[^\n]*'장르 스킬'", screen)
    assert re.search(r"미리보기에는[^\n]*'크게 보기'[^\n]*'라이브 방송'", screen)
    assert "사이드바 '스킬 · 에이전트'의 '장르 스킬'" in s


def test_the_chat_is_named_without_a_place_it_only_has_on_a_narrow_screen():
    """From 900 px the chat is the right column (web/src/origin.css): the prompt calls it 채팅, not 아래 채팅."""
    screen = _section("화면")
    assert "아래 채팅" not in prompts.SYSTEM and "위 탭들" not in screen
    line = next(row for row in screen.splitlines() if row.startswith("- 채팅"))
    assert "오른쪽" in line and "아래" in line and "'작업 기록'" in line
    css = (WEB / "origin.css").read_text(encoding="utf-8")
    assert re.search(r'@media \(min-width: 900px\) \{\s*\.app \{[^}]*"hero chat" "main chat"', css)  # the right column


def test_the_broadcast_is_told_in_the_leads_words():
    screen = _section("화면")
    for name in ("전체 화면 트레일러", "플레이어블 광고", "코너 트레일러", "가상 시청자"):
        assert name in screen, name
    # the services behind it are named once, in the rule that says not to name them
    rule = next(line for line in _section("답변 쓰는 법").splitlines() if "AWS 서비스 이름" in line)
    rest = _agent_copy().replace(rule, "")
    for service in ("MediaTailor", "GameLift", "SSAI", "IVS", "Pegasus", "Deadline"):
        assert service in rule or service in ("SSAI", "Pegasus", "Deadline"), service
        assert service not in rest, service


# ── times ──────────────────────────────────────────────────────────────────────

def test_every_time_the_agent_states_ahead_is_the_cards():
    web = (WEB / "types.ts").read_text(encoding="utf-8")
    for kind, usual in waits.CARD_TYPICAL.items():  # JOB_TYPICAL's image, trailer and shot
        assert f"{kind}: '{usual}'" in web, kind
    assert waits.IMAGE == waits.CARD_TYPICAL["image"]
    assert f"render3d: '{waits.RELIEF}'" in web  # a relief, a background's panel: the render job alone
    for model, usual in waits.SHOT_TYPICAL.items():  # SHOT_TYPICAL, by video model
        assert re.search(rf"'?{re.escape(model)}'?: '{re.escape(usual)}'", web), model
    copy = _agent_copy()
    assert f"한 장에 {waits.IMAGE}" in prompts.SYSTEM
    assert f"대안({waits.RELIEF})" in prompts.SYSTEM
    assert waits.SHOT_TYPICAL["ltx"] in prompts.SYSTEM and waits.SHOT_TYPICAL["minimax-h3"] in prompts.SYSTEM
    assert f"한 샷에 {waits.SHOT_TYPICAL['kandinsky-6-0-video-pro']}" in prompts.SYSTEM
    for stale in ("20–60초", "10–20분", "~25분"):
        assert stale not in copy, stale
    assert "10–20분" not in tools.BACKGROUND_3D + tools.NOTICE_BACKGROUND_3D
    assert waits.RELIEF in tools.BACKGROUND_3D and waits.RELIEF in tools.NOTICE_BACKGROUND_3D
    assert len(tools.NOTICE_BACKGROUND_3D) <= 60


# ── the reply ──────────────────────────────────────────────────────────────────

def test_the_reply_rules_ask_for_a_short_plain_answer_that_ends_with_the_next_step():
    rules = _section("답변 쓰는 법")
    assert "해요체" in rules and "합니다체" in rules
    assert "첫 줄은" in rules and "마지막 줄은" in rules and "다음에 할 일 하나" in rules
    assert re.search(r"보통 2–5줄, 길어도 8줄", rules)
    for never in ("ip_", "job_", "gm_", "sf-shooter", "도구 이름", "필드 이름", "#rrggbb"):
        assert never in rules, never
    assert "모델 이름" in rules and "AWS 서비스 이름" in rules and "물었을 때만" in rules
    assert "방송 중 광고" in rules and "클라우드 플레이" in rules
    for plain in ("배경을 지운 그림", "납작한 그림으로 나와요", "게임 시작 전 광고", "쇼츠"):
        assert plain in rules, plain
    # the steps of a 3D chain by their cards' names (test_round20_copy.py)
    assert "작업 카드의 이름으로 말한다" in rules and all(label in rules for label in waits.STEP_LABEL.values())
    assert "한 가지로 말한다" in rules and "둘 중 하나라고 쓰지 않는다" in rules
    assert "작업 카드와 같은 값" in rules
    # after a game: what to press next, by the screen's names
    assert re.search(r"게임을 만든 답[^\n]*'게임 시작'[^\n]*'라이브 방송'[^\n]*'게시하기'", rules)


def test_the_rules_no_longer_ask_for_the_engineers_sentences():
    s = prompts.SYSTEM
    assert "모델이 만든 선언형 설계와 실제 브라우저 실행 검증은 구분한다" not in s
    assert "해 보고 확인한 것처럼 말하지 않는다" in s
    # the examples the prompt itself gives are in the speech level it asks for
    for formal in ('"지금 그림은 vN입니다"', '"게임 요청을 보류해 두었습니다"', "지금 그림은 v1 그대로입니다"):
        assert formal not in s, formal
    assert '"지금 그림은 vN이에요"' in s and '"게임 요청을 보류해 두었어요"' in s


def test_ids_and_colour_codes_in_brackets_never_reach_the_bubble():
    said = ("컨셉을 잡았어요. 팔레트는 달빛 보라(#7f8cff), 밤 남색 (#1b1f3a)이에요.\n"
            "- 테오(ip_98e2ca089d)를 주인공으로 했어요.\n- 게임(gm_95a1aa4ee7)은 오른쪽에 있어요.")
    assert agent._strip_marker(said) == ("컨셉을 잡았어요. 팔레트는 달빛 보라, 밤 남색이에요.\n"
                                         "- 테오를 주인공으로 했어요.\n- 게임은 오른쪽에 있어요.")
    # a bracket that holds words stays, and so does an id the user asked for by itself
    kept = "꼬마 마법사(주인공)의 그림(v2)이에요. 게임 ID는 gm_95a1aa4ee7이에요."
    assert agent._strip_marker(kept) == kept


def test_the_lines_the_server_itself_writes_into_the_chat_are_in_the_same_speech_level():
    for line in (agent.LIMIT_NOTE, agent.TIME_NOTE, agent.TRUNCATED):
        assert re.search(r"(요|세요)\.$", line) and "습니다" not in line and "됩니다" not in line, line
