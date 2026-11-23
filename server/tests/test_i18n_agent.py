"""The agent on an English page: the system prompt's language section, and everything the server reads in the user's
message or the agent's reply with Korean patterns, read in English too. The Korean tables these mirror are
test_round20_hold.py (the held-game guarantee), test_round20_games.py (a survive game's request) and
test_round20_copy.py / test_round21_copy.py (the reply's words). (The schedule field: test_i18n_texts.py.)"""
import re

import pytest

from server import agent, gamespec, i18n, prompts, store, tools
from server.city_contract import is_city_request
from server.tests.conftest import FakeBedrockRT, FakeS3, FakeTable, make_ctx
from server.tests.test_agent import _final
from server.tests.test_round20_hold import _ask, _calls, _hero, _message
from server.tests.test_tools import BUCKET, RUNTIME3D, _glb, _session

HANGUL = re.compile(r"[가-힣]")


@pytest.fixture(autouse=True)
def korean_after():
    yield
    i18n.use("ko")


@pytest.fixture
def ctx():
    c = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=FakeBedrockRT())
    for name in RUNTIME3D:
        c.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = name.encode()
    return c


@pytest.fixture
def session(ctx):
    s = _session(ctx)
    i18n.use("en")  # the turn's language is its payload's: the page that sent the message was in English
    return s


# ── the prompt ─────────────────────────────────────────────────────────────────

def test_the_korean_prompt_is_as_it_was():
    assert prompts.system("ko") is prompts.SYSTEM and prompts.system() is prompts.SYSTEM
    assert "## Language: English" not in prompts.SYSTEM and "항상 한국어로" in prompts.SYSTEM


def test_the_english_prompt_adds_a_language_section_before_the_state():
    en = prompts.system("en")
    assert "항상 한국어로" not in en  # the one rule that would contradict it
    section = en[en.index("## Language: English"):en.index("## 현재 상태 (state)")]
    assert en.endswith("## 현재 상태 (state)\n{state}\n")  # the state is the prompt's last word
    # every rule before the section is the Korean prompt's, word for word
    before = en[:en.index("## Language: English")]
    assert before == prompts.SYSTEM[:prompts.SYSTEM.index("## 현재 상태 (state)")].replace(
        prompts._ALWAYS_KOREAN, "- 짧고 구체적으로 답한다(답의 언어는 아래 'Language: English' 절을 따른다).")
    for rule in ("Reply in English", "no exclamation marks", "no Korean left in an English sentence",
                 "If the user writes in Korean or asks for Korean, reply in Korean",
                 "New content you create is in English", "IP names and roles", "game titles", "briefing",
                 "intertitle cards", "never translate an IP's name",
                 "Say what they say in English and keep every number as it is", "\"about 3 min\"",
                 "[에셋 수정 ipId=…]", "[게임 수정 gameId=…]", "The text after them may be English",
                 "only as hold_game_request's result"):
        assert rule in section, rule


def test_the_english_screen_is_built_from_the_label_table():
    """The server names buttons, tabs and steps by the same English labels the web shows (the round's glossary)."""
    section = prompts.language_section_en()
    screen = section[section.index("### Screen (English page)"):section.index("### Korean name → English label")]
    assert not HANGUL.search(screen)  # every {한국어 이름} place was filled
    for ko in ("스킬 · 에이전트", "장르 스킬", "연결 서비스", "게시하기", "캐릭터", "소품", "버전 기록", "이 버전 쓰기", "3D로 만들기",
               "수정하기", "다시 뽑기", "작업 현황", "다시 시도", "그림 다시 뽑기", "게임 설계", "게임 시작", "크게 보기", "라이브 방송",
               "이 게임 수정", "작업 기록", "라이브 켜기", "라이브 끄기", "전체 화면 트레일러", "플레이어블 광고", "코너 트레일러",
               "가상 시청자", "3D용 자세 그림", "3D 모델", "움직임 뼈대", "3D 회전 영상", "배경 제거", "검사 실패"):
        assert i18n.LABELS[ko] in screen, ko
    assert f"'{i18n.LABELS[tools.HELD_BUTTON]}' button" in section and f"'{i18n.LABELS[tools.REMAKE_BUTTON]}'" in section
    table = section[section.index("### Korean name → English label"):]
    for ko, en in i18n.LABELS.items():
        if HANGUL.search(ko):
            assert f"- {ko} → {en}" in table
    with pytest.raises(KeyError):  # a name the table does not have is an error, not a Korean word in the prompt
        prompts._labels_en("'{없는 이름}'")


def test_a_turn_on_an_english_page_gets_the_english_prompt_and_a_korean_one_does_not(ctx, session):
    sid = session["sessionId"]
    _, pending = _ask(ctx, sid, "make me a character")
    ctx.bedrock_rt_east._responses = [_final("I'm drawing Theo. It appears in the 'Characters' tab in about 3 min.")]
    agent.run_turn(ctx, sid, pending["messageId"])
    system = ctx.bedrock_rt_east.calls[-1]["system"][0]["text"]
    assert "## Language: English" in system and '"genreLabel": "Sci-fi shooter"' in system
    assert i18n.lang() == "en"

    # the session's own word (its latest work-starting request) does not decide a turn
    store.set_lang(ctx, session, "ko")
    _, pending = _ask(ctx, sid, "and a prop")
    ctx.bedrock_rt_east._responses = [_final("I'm drawing a lantern.")]
    agent.run_turn(ctx, sid, pending["messageId"])
    assert "## Language: English" in ctx.bedrock_rt_east.calls[-1]["system"][0]["text"]

    i18n.use("ko")  # a turn a Korean page started
    other = _session(ctx)
    store.set_lang(ctx, other, "en")
    _, pending = _ask(ctx, other["sessionId"], "캐릭터 만들어줘")
    ctx.bedrock_rt_east._responses = [_final("테오를 그리고 있어요.")]
    agent.run_turn(ctx, other["sessionId"], pending["messageId"])
    system = ctx.bedrock_rt_east.calls[-1]["system"][0]["text"]
    assert "## Language: English" not in system and '"genreLabel": "SF 슈터"' in system and i18n.lang() == "ko"


# ── the reply's words ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("reply, shown", [
    ("I called render_3d for Theo.", "I called Make 3D for Theo."),
    ("The genre stays sf-shooter and the image state is check_failed.",
     "The genre stays Sci-fi shooter and the image state is Check failed."),
    ("Press '게임 만들기' when the 3D is ready, or open the \"작업 현황\" tab.",
     "Press 'Make game' when the 3D is ready, or open the \"Jobs\" tab."),
    ("The genre is Sci-fi shooter (sf-shooter).", "The genre is Sci-fi shooter."),
    ("The turntable is being rendered on the GPU 박스.", "The Turntable video is being rendered on the GPU server."),
    ("Theo(ip_98e2ca089d) is drawn in Moonlit Violet(#7f8cff).", "Theo is drawn in Moonlit Violet."),
    ("[Server note · 2026-11-23 10:00 KST · jobs in progress: none] Theo is ready.", "Theo is ready."),
    ("[서버 메모 · 2026-11-23 10:00 KST · 지금 진행 중인 작업: 없음] Theo is ready.", "Theo is ready."),
    # a user's own Korean name is content: it is not a label unless the reply quotes exactly a label
    ("꼬마 마법사 is being drawn. It appears in the 'Characters' tab.", "꼬마 마법사 is being drawn. It appears in the 'Characters' tab."),
])
def test_an_english_reply_says_the_screens_english_names(reply, shown):
    i18n.use("en")
    assert agent._strip_marker(reply) == shown


def test_a_korean_reply_on_an_english_page_keeps_the_korean_rules():
    """The user wrote in Korean, so the reply is Korean: its names are the Korean ones, with their particles."""
    i18n.use("en")
    assert agent._strip_marker("render_3d를 다시 걸었어요.") == "3D로 만들기를 다시 걸었어요."
    assert agent._strip_marker("") == "Done."
    i18n.use("ko")
    assert agent._strip_marker("") == "완료했어요."
    assert agent._strip_marker("Press '게임 만들기'.") == "Press '게임 만들기'."  # a Korean page's reply is untouched


# ── the held-game guarantee, in English ────────────────────────────────────────

@pytest.mark.parametrize("text, asks", [
    # asks to make a game
    ("Make a 30-second survival game with these IPs", True), ("make a game", True), ("Make game", True),
    ("Please build me a zombie survival game.", True), ("Create a new game with these characters", True),
    ("Can you make a game with these?", True), ("Could you please make a racing game?", True),
    ("Let's make a game", True), ("I want a 60-second boss game", True), ("I'd like to make a platformer game", True),
    ("Turn this into a game", True), ("Make one more game", True), ("make the game now", True),
    ("First make the 3D and then make the game", True), ("Make a game when the 3D is done", True),
    ("Make a game. If the 3D is not ready, hold it.", True), ("generate a shooter game please", True),
    # speaks of one
    ("How do I make a game?", None), ("Can I make a game like this?", None), ("What do I need to make a game?", None),
    ("Make a character for the game", None), ("Make a game background", None), ("Make a game trailer", None),
    ("Publish the game", None), ("Before making the game, draw the character first", None),
    ("Was the game made?", None), ("Why didn't you make the game?", None), ("Make the game later", None),
    ("Delete the game", None), ("Thanks for making the game", None), ("You made the game earlier. Show it.", None),
    ("Make Little Wizard into a game character", None), ("Is the game ready?", None),
    ("[게임 수정 gameId=gm_1] Make the enemies faster and make the game harder", None),
    ("[에셋 수정 ipId=ip_1] Lira: make her brighter so she shows well in the game", None),
    ("[게임 수정 gameId=gm_1] The new 3D is ready, so make the game again with the same design. Leave the rest.", None),
    # asks for none
    ("Make Little Wizard's 3D", False), ("Make the 3D. Don't make the game yet.", False),
    ("No game for now, just the 3D", False), ("Make a video instead of a game", False),
    ("Cancel the game request", False), ("Make it now", False), ("Do not build the game", False),
])
def test_what_a_game_request_is_in_english(text, asks):
    assert agent._asks_game({"text": text}) is asks


# A request for a thing that is game-something ("a game-ready 3D model", "a board game piece prop") or an edit of the
# game that exists is not a request to make a game: read as one, the page would offer "Make game" unasked. Everyday
# lines in both directions.
@pytest.mark.parametrize("text, asks", [
    # ── a thing that is game-something, an edit of the game that exists ──
    ("make a game-ready 3D model of Luna", None), ("Make the game harder", None), ("Make a board game piece prop", None),
    ("make it game-ready", None), ("Generate a game-ready sword", None), ("Make the game easier", None),
    ("make the game faster", None), ("Make the game a bit longer", None), ("make the game look darker", None),
    ("Make the game feel scarier", None), ("can you make the game shorter?", None), ("Please make the game more fun", None),
    ("Would you make the game a bit harder?", None), ("make the game 60 seconds long", None),
    ("Make the game's title bigger", None), ("make the game work on my phone", None), ("Make sure the game has a boss", None),
    ("make the hero bigger and the game harder", None), ("I want the game to be harder", None),
    ("I need the game to last longer", None), ("make the enemies in the game slower", None),
    ("Make the boss of the second game bigger", None), ("make a card game card of Luna", None),
    # things OF a game
    ("Make a game character", None), ("create a game asset pack", None), ("Make a game icon", None),
    ("make a game logo for Luna", None), ("Make a game over screen", None), ("make a new game mode", None),
    ("Build a level for the game", None), ("make a new background for the game", None), ("Make game music", None),
    ("make a game poster", None), ("Make an in-game shop", None), ("create a game plan for the stream", None),
    ("Make an RPG hero", None), ("Make a platformer character", None), ("make a game trailer and publish the game", None),
    # thanks, praise, talk
    ("Thanks for the game", None), ("thank you, the game is great", None), ("Great game!", None), ("I love the game", None),
    ("I like the game a lot", None), ("The game looks amazing", None), ("Nice, that game was fun", None),
    ("I'm making a game about cats", None), ("I made a game yesterday", None),
    # questions about how and when
    ("How long does making a game take?", None), ("When will the game be ready?", None), ("what can the game do?", None),
    ("Does the game need 3D?", None), ("Can I make a game without 3D?", None), ("Should I make a game now?", None),
    ("Is it possible to make a game with two heroes?", None), ("where is the game?", None),
    ("Did you make the game?", None), ("I don't know how to make a game", None), ("What do I press to make a game?", None),
    ("To make a game you need a hero first, right?", None), ("the button to make a game is missing", None),
    ("You can't make a game without a hero", None), ("Why don't we make a game?", None),
    # the game for another time, or what comes before it
    ("Leave the game for later", None), ("We'll make the game afterwards", None),
    ("After you build the game, publish it", None), ("until we make the game, keep drawing", None),
    # other things done to a game
    ("Play the game", None), ("I want to play the game", None), ("Open the game", None), ("Edit the game", None),
    ("Start the game design", None), ("show me the game", None), ("Share the game link", None),
    # asks for none
    ("don't make the game yet", False), ("Don't build a game, just the trailer", False), ("no game yet", False),
    ("Not the game yet, just the 3D", False), ("skip the game", False), ("hold off on the game", False),
    ("I don't want a game", False), ("we don't need a game right now", False), ("forget the game", False),
    ("Make Luna's 3D", False), ("thanks", False), ("Thanks, that looks great!", False), ("make it playable", False),
    ("How long does 3D take?", False), ("Make the hero taller", False),
    # ── requests ──
    ("can you build me a quick survival game with these", True), ("let's make a game", True),
    ("turn this into a game", True), ("I want a racing game", True), ("game please", True),
    ("another game, 60 seconds this time", True), ("A game please", True), ("Let's do the game now", True),
    ("Game time! Build it.", True), ("give me a boss fight game", True), ("Could I get a racing game with this car?", True),
    ("build a platformer with these characters", True), ("Make a hack-and-slash with the knight", True),
    ("make me a game", True), ("Make a video game with Luna", True), ("make the game", True), ("Make the game, please", True),
    ("please make the game now that the 3D is done", True), ("Make the game with Luna as the hero", True),
    ("make my game", True), ("Build the game from the design", True), ("make the game again", True),
    ("ok now make a game", True), ("Now build a game where Luna fights zombies", True),
    ("Make a game 60 seconds long", True), ("make a game I can play in the browser", True),
    ("I'd like a game with Luna and the wolf", True), ("We need a game for tonight's stream", True),
    ("I want to make a game", True), ("I want you to make a game", True), ("I need you to build a shooter game", True),
    ("Would you make a game for me?", True), ("could you create a game out of these IPs?", True),
    ("Make it a game", True), ("make these into a game", True), ("Turn Luna and the wolf into a survival game", True),
    ("one more game please", True), ("And now the game", True), ("Make the hero bigger and make a game", True),
    ("get me a platformer game", True), ("make an RPG with these", True), ("Create a roguelike", True),
    ("make a space shooter with Luna", True), ("produce a 30-second boss rush game", True),
    ("Luna is done. Make the game.", True), ("The 3D looks good, so make a game with it", True),
    ("I was wondering, could you make a game out of these?", True), ("You said you'd make a game", True),
    # ── a second batch, written after the rule and not tuned on ──
    ("Make the game background darker", None), ("make the second game's hero taller", None),
    ("make a 3D model for the game", None), ("Make Luna the hero of the game", None), ("Make the game music louder", None),
    ("make the trailer for the game", None), ("Can you make the game load faster?", None),
    ("Make the game start with a cutscene", None), ("make the game end after 60 seconds", None),
    ("Make the game brighter please", None), ("The game crashed, make it work", None),
    ("Make a thumbnail for my game", None), ("I think the game is too hard", None), ("Create a poster of the game", None),
    ("Make a game-style portrait of Luna", None), ("make game-ready textures", None),
    ("Generate game art for the hero", None), ("Build a game world map", None), ("Make Luna look like a game boss", None),
    ("make a character like in a fighting game", None), ("Make a prop from the game Zelda", None),
    ("draw a video game controller prop", None), ("Make a retro game console prop", None),
    ("make an arcade game cabinet", None), ("Make the game not so dark", None), ("we made the game too easy", None),
    ("If I make a game later, will Luna be in it?", None), ("Does make game cost anything?", None),
    ("What happens when I press Make game?", None), ("Who can make a game here?", None),
    ("I pressed Make game but nothing happened", None), ("The Make game button is gone", None),
    ("you already made a game, right?", None), ("no more games for today", None),
    ("Make the 3D first, the game can wait", None), ("3D first. Game later.", None),
    ("Make a new character for my next game", None), ("I'd love the game to have a boss", None),
    ("I'd like the game shorter", None), ("We want the game in English", None), ("Make a shooter enemy", False),
    ("Make a racer", False), ("I would like to see the game", None), ("Let's try the game", None),
    ("let's have a look at the game", None), ("Give me the game link", None), ("Get me the game's address", None),
    ("Can I have the game file?", None), ("make a hunger games style arena prop", None),
    ("So... a game?", None), ("How about a game?", None),
    ("Make a game with Luna", True), ("please make a zombie game", True), ("Build me a racing game, 60 seconds", True),
    ("Could you whip up a quick game?", True), ("Okay, game now", True), ("now make the game please", True),
    ("Go ahead and make the game", True), ("yes, make the game", True), ("Make a game where the wolf chases Luna", True),
    ("make a short game for the stream", True), ("Make a new game", True), ("I need a game by tonight", True),
    ("Make us a co-op game", True), ("create game", True), ("Make a 2-minute exploration game", True),
    ("Time to make the game", True), ("Ready to make the game", True), ("I want to build a game with these IPs", True),
    ("Put together a game with all of them", True), ("make a game and a trailer", True),
    ("make a trailer and a game", True), ("Make a game, then publish it", True), ("Let's make the game!", True),
    ("Can we get a game going?", True), ("Make a mini game", True), ("make a horror game set in a subway", True),
])
def test_everyday_english_lines_as_game_requests(text, asks):
    assert agent._asks_game({"text": text}) is asks


@pytest.mark.parametrize("text", [
    # requests the reading does not see: the server's guarantee is lost for them, and the agent's own
    # hold_game_request still works. A miss is the safe side: a line wrongly read as a request is offered as a game
    # nobody asked for
    "I want to play as Luna in a shooter", "Start the game design and build it", "Make this playable",
    "Let's try a platformer game", "make a hero, a sword and a game", "Make a game design and then the game",
    "Make a card game", "Do a game", "make the best game ever",
])
def test_english_requests_the_reading_misses(text):
    assert agent._asks_game({"text": text}) is not True


@pytest.mark.parametrize("reply", [
    "I've started Luna's 3D. A Download button appears in the 3D tab when it is done (about 15 min).",
    "A button appears on screen when the 3D is done.", "The Retry button shows up if a step fails.",
    "Press the Expand button to see it larger.", "The 'Make 3D' button appears once the picture is in.",
    "When the Rig is in, a Play button shows up on the card.",
])
def test_a_button_that_is_not_make_game_promises_no_game(reply):
    """B3: any "button … appears" counted as the held request's button."""
    assert agent._says_hold(reply, True) is None and agent._says_hold(reply, False) is None


@pytest.mark.parametrize("text, reply", [
    ("make a game-ready 3D model of Luna",
     "I've started Luna's 3D. A Download button appears in the 3D tab when it is done (about 15 min)."),
    ("Make the game harder", "An edit needs the game first. Once Luna's 3D is ready, the 'Make game' button appears."),
    ("Make a board game piece prop", "I'm drawing the piece. When its 3D is done, a 'Make game' button appears."),
    ("make it game-ready", "I've started the 3D. The Make game button shows up when it is in."),
    ("Thanks for the game", "You're welcome. The 'Make game' button appears again when the new 3D is ready."),
])
def test_an_english_line_that_asks_for_no_game_is_never_marked_as_a_held_game(ctx, session, text, reply):
    sid = session["sessionId"]
    _hero(ctx, sid, "Luna")
    asked, pending = _ask(ctx, sid, text)
    ctx.bedrock_rt_east._responses = [_calls(("render_3d", {"ipId": "ip_hero"})), _final(reply)]
    agent.run_turn(ctx, sid, pending["messageId"])
    assert "gameHeld" not in _message(ctx, sid, asked)


@pytest.mark.parametrize("reply, says", [
    # holds said in other words
    ("I've saved your request for when the 3D finishes.", True), ("I'm holding off on the game until the 3D is done.", True),
    ("Your request is queued behind the 3D.", True), ("I've paused the game request until 3D is ready.", True),
    ("We'll get to the game once the hero's 3D model is finished; your request is kept.", True),
    ("I can't make the game until the 3D is ready, so I've noted your request.", True),
    ("I'll keep your game request until Luna's 3D is in.", True), ("Your game request is saved.", True),
    ("I'll hold off on making the game until the Rig is done.", True), ("The game request is parked for now.", True),
    ("I've kept your request on record.", True), ("Your request has been noted and waits for the 3D.", True),
    ("I have put the game aside until the 3D is ready.", True), ("The game is on hold until the 3D completes.", True),
    # denials
    ("I haven't saved any request.", False), ("No request is queued.", False), ("There is no game request on hold.", False),
    ("I'm not holding off on anything.", False), ("Your request wasn't kept.", False), ("Nothing has been put aside.", False),
    ("I didn't hold the game request.", False),
    # an offer to hold is no hold; a question about one says nothing
    ("Should I hold the game request until the 3D is done?", False), ("Do you want me to put the request on hold?", False),
    ("Is the request still on hold?", None), ("Was a request put on hold earlier?", None),
    # a game that was made
    ("I made the game \"Moonlit Run\".", False), ("Your game is ready. Press 'Play'.", False),
    ("The game has been built with Luna as the hero.", False), ("I've rebuilt the game with the new 3D.", False),
    ("Done. I created a 60-second survival game.", False), ("The game's ready in the Preview tab.", False),
    # neither
    ("I kept the picture as it was.", None), ("I saved the new version of Luna.", None), ("The 3D job is queued.", None),
    ("I've noted the colours you asked for.", None), ("Luna's 3D is paused until the GPU server is free.", None),
    ("I kept the game as it was.", None), ("The edit is on hold until the picture is in.", None),
    ("The picture is saved in Version history.", None), ("I started the 3D. It takes about 15 min.", None),
    ("If you ask for a game now, I'll save the request until the 3D is done.", None),
    ("The game needs Luna's 3D first.", None), ("Which IP should be the hero of the game?", None),
    # ── a second batch, not tuned on ──
    ("I've put a hold on your game request until the 3D is ready.", True), ("I'll remember your game request.", True),
    ("The request waits until Luna's 3D is ready.", True), ("I've deferred the game request.", True),
    ("I postponed the game until the 3D lands.", True),
    ("I haven't made the game yet.", None), ("The game isn't ready yet.", None),
    ("The game is not made yet; the 3D comes first.", None), ("I saved the game design.", None),
    ("I kept your earlier picture.", None), ("I noted that you want a darker look.", None),
    ("The trailer request is queued.", None), ("Luna's picture request is saved.", None),
    ("I made a game trailer.", None), ("I created the game background.", None),
    ("The Make 3D request is on hold until the picture is in.", None), ("The game was made 2 minutes ago.", False),
    # holds and made games in words the reading does not see (None: the request's own reading then decides)
    ("Your game request is on the list for when the 3D is done.", None),
    ("I'll come back to the game once the 3D is finished.", None), ("Your request is safe; it waits for the 3D.", True),
    ("The game has to wait for the 3D.", None), ("Your new game \"Ash Run\" is in the Game tab.", None),
    ("Here is your game.", None), ("The game was rebuilt.", None), ("Game made. Press Play.", None),
])
def test_everyday_english_replies_as_holds(reply, says):
    assert agent._says_hold(reply, False) is says


@pytest.mark.parametrize("reply", [
    "The game will be built automatically when the 3D completes.", "Hold tight, the 3D is cooking. The game comes right after.",
    "Once the 3D finishes, I'll build the game.", "When Luna's 3D is ready, the 'Make game' button appears.",
    "As soon as the 3D completes the game will be made.", "The game follows right after the 3D.",
    "Press the Make game button once the 3D is done.", "The button to make the game appears when the 3D is in.",
])
def test_an_english_promise_of_the_game_counts_only_under_a_request_to_make_one(reply):
    assert agent._says_hold(reply, True) is True and agent._says_hold(reply, False) is None, reply


@pytest.mark.parametrize("reply, says", [
    # the request put aside, as something done or promised
    ("I've put your game request on hold.", True), ("Your game request is on hold until Theo's 3D is ready.", True),
    ("The request is on hold.", True), ("I'll hold the game request until the 3D is done.", True),
    ("I put the game on hold for now.", True), ("The game request stays on hold.", True),
    ("Your request is held until the Rig is in.", True), ("The game is waiting for Theo's 3D.", True),
    ("I'm holding your game request.", True), ("I've set your request aside for later.", True),
    # nothing is held, or the game exists
    ("No game request is on hold.", False), ("Nothing is on hold.", False), ("I haven't put the request on hold.", False),
    ("Shall I put the game request on hold?", False), ("I made the game.", False), ("The game is ready.", False),
    ("I've made the wave survival game \"After the Ash: Subway Defense\".", False),
    ("The second game has been created as a new version.", False), ("I built your game. Press 'Play'.", False),
    # neither: a rule, a hold that already stands, a 3D that was queued
    ("If you ask for a game before the 3D is done, the request is put on hold.", None),
    ("The \"30-second survival\" request on hold is still there.", None), ("I've queued Serin's 3D.", None),
    ("The wolf's 3D for the game is waiting in the queue.", None), ("You can make the game once the 3D is done.", None),
    # ... and what was made is not the game
    ("I made a character for the game first.", None), ("I made the game design.", None),
    ("The game could not be made yet.", None), ("The game will be ready once the 3D is ready.", None),
])
def test_what_an_english_reply_says_of_a_hold(reply, says):
    assert agent._says_hold(reply, False) is says


def test_an_english_button_or_promise_counts_only_under_a_request_to_make_a_game():
    # (a button the reply does not name is not it: test_a_button_that_is_not_make_game_…)
    for reply in ("When the 3D is done, a 'Make game' button appears.",
                  "Once the 3D is done I'll make the 30-second survival game.",
                  "I'll make the game as soon as Moonlit Spear's 3D is ready.",
                  "The Make game button shows up when the 3D is in."):
        assert agent._says_hold(reply, True) is True and agent._says_hold(reply, False) is None, reply
    assert agent._says_hold("Nothing is on hold. A 'Make game' button appears when the 3D is done.", True) is False


@pytest.mark.parametrize("said", [
    "I've queued Theo's 3D. Once the 3D is done I'll make the 30-second survival game.",
    "I started the 3D. You can make the game once the 3D is done.",
    "The 3D comes first. I started it.",
    "I've put your game request on hold. A 'Make game' button appears when the 3D is ready.",
])
def test_an_english_game_request_before_its_heros_3d_is_held_whatever_the_reply_says(ctx, session, said):
    sid = session["sessionId"]
    _hero(ctx, sid, "Theo")
    asked, pending = _ask(ctx, sid, "Make a 30-second survival game with these IPs")
    ctx.bedrock_rt_east._responses = [_calls(("render_3d", {"ipId": "ip_hero"})), _final(said)]
    agent.run_turn(ctx, sid, pending["messageId"])
    assert _message(ctx, sid, asked)["gameHeld"] == {"ipIds": ["ip_hero"]}


@pytest.mark.parametrize("text, reply", [
    ("Make Theo's 3D", "I started the 3D. Once the 3D is done I'll make the game. A 'Make game' button appears then."),
    ("Make a 30-second survival game with these IPs", "I made the game \"Moonlit Run\". Press 'Play' in the 'Preview' tab."),
    ("Make a 30-second survival game with these IPs",
     "Theo's picture is still being drawn. Ask again when the picture appears."),
    ("Is anything on hold?", "No game request is on hold."),
])
def test_an_english_turn_that_holds_nothing_marks_nothing(ctx, session, text, reply):
    sid = session["sessionId"]
    _hero(ctx, sid, "Theo")
    asked, pending = _ask(ctx, sid, text)
    ctx.bedrock_rt_east._responses = [_final(reply)]
    agent.run_turn(ctx, sid, pending["messageId"])
    assert "gameHeld" not in _message(ctx, sid, asked)


def test_an_english_hold_names_the_ip_it_waits_for(ctx, session):
    """The hero is ready and the reply holds the request for a weapon it names: tools.hold_cast reads the name."""
    sid = session["sessionId"]
    _hero(ctx, sid, "Theo")
    _glb(ctx, sid, "ip_hero")
    _hero(ctx, sid, "Moonlit Spear", "ip_spear")
    store.update_ip(ctx, sid, "ip_spear", kind="weapon")
    asked, pending = _ask(ctx, sid, "Make a game where Theo fights with the Moonlit Spear")
    ctx.bedrock_rt_east._responses = [_final("I've put your game request on hold until Moonlit Spear's 3D is ready.")]
    agent.run_turn(ctx, sid, pending["messageId"])
    assert _message(ctx, sid, asked)["gameHeld"] == {"ipIds": ["ip_spear"]}


# ── a game request's own numbers, an edit's backdrop, a city ───────────────────

@pytest.mark.parametrize("prompt, auto", [
    ("30-second survival with auto-fire", True), ("a survival game with automatic attack", True),
    ("the hero attacks automatically", True), ("auto aim shooter", True), ("vampire survivors style", True),
    ("the hero shoots enemies automatically", True),
    ("30-second survival", False), ("survival, auto attack off", False), ("no auto-fire, I want to aim myself", False),
    ("automatic attack is disabled", False), ("without automatic attacks", False), ("turn off auto fire", False),
    ("auto-fire should stay off", False), ("an automatic door opens at the end", False),
])
def test_an_automatic_attack_asked_for_in_english(prompt, auto):
    asked = any(not gamespec._TURNED_OFF.match(prompt, m.end()) and not gamespec._NOT_BEFORE.search(prompt[:m.start()])
                for m in gamespec._AUTO_ASKED.finditer(prompt))
    assert asked is auto


@pytest.mark.parametrize("prompt, named", [
    ("survival with HP 120", True), ("give the hero 150 health", True), ("hero health of 200", True),
    ("hit points: 90", True), ("a 30-second survival with 120 HP", True), ("health is 80", True),
    ("the boss rages below 50% health", False), ("health 50 percent triggers rage", False), ("a healthy hero", False),
    ("survive 30 seconds", False), ("HP potions drop", False),
])
def test_an_hp_named_in_english(prompt, named):
    assert bool(gamespec._HP_ASKED.search(prompt)) is named


def test_a_revision_and_a_setting_are_read_from_an_english_request():
    assert gamespec.revises("[게임 수정 gameId=gm_1] Make the enemies faster. Leave the rest as it is.") == "gm_1"
    assert gamespec.revises("Make the enemies faster") is None
    spec = {"version": 2, "world": {}, "artDirection": {"biome": "industrial"}}
    gamespec.apply_setting(spec, "a rainy neon harbor at night")
    assert spec["artDirection"] == {"biome": "night-city", "timeOfDay": "night", "weather": "rain", "setting": "harbor"}
    snowy = {"version": 2, "world": {}, "artDirection": {"biome": "snow"}}
    gamespec.apply_setting(snowy, "a snowy pass at dusk")
    assert snowy["artDirection"]["weather"] == "snow" and snowy["artDirection"]["timeOfDay"] == "dusk"


@pytest.mark.parametrize("text, city", [
    ("an open-world city game", True), ("GTA style downtown chase", True), ("a forest, not a city", False),
    ("a canyon race outside the city", False), ("Environment: night-city\nA rooftop duel", False),
])
def test_a_city_request_in_english(text, city):
    assert is_city_request(text) is city


@pytest.mark.parametrize("change, backdrop", [
    ("a huge pale moon directly behind it", True), ("standing in a snowy forest", True), ("change the background to a castle hall", True),
    ("a sky-blue cape", False), ("sunset orange hair", False), ("a crescent moon pendant", False),
])
def test_an_edits_backdrop_is_read_from_the_agents_english_prompt(change, backdrop):
    """The edit drawer's marker stays Korean and its free text may be English; the change the server reads is the
    agent's own English prompt either way."""
    assert tools._names_backdrop(change) is backdrop


def test_the_english_page_asks_for_plain_text_and_stored_names_as_they_are():
    """A chat shows text as typed, so an English reply uses no Markdown; and a reply names what the screen shows by
    its stored name (Moonwood Wizard, 'Characters'), not a translation of it."""
    from server import prompts
    section = prompts.language_section_en()
    assert "No Markdown" in section and "**bold**" in section
    assert "never translate a stored name" in section and "English label this page shows" in section
    assert "with the Korean names of the screen" not in section
