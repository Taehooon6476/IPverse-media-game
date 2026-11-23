"""The server's two languages. Korean is the source text and the default; English is a dictionary keyed by the Korean
sentence, as on the web (web/src/i18n.ts).

The language of a request is its `X-Lang` header (ko | en; anything else is ko), read once per request
(app.handler → use()). Work that goes on after its request answers in the language of the request that STARTED it,
never in that of whichever page polls meanwhile:
 - a self-invoke (an agent turn, a card button's background tool, a highlight) carries it in its payload ("lang"),
   which the handler reads where there is no header (from_event);
 - a chain of jobs whose end is told in the chat carries it on its mark (agent.watch);
 - anything else written outside a request uses session.lang, the language of the latest POST that started work
   in the session (remember()). A GET never writes.

tr("한국어 문장 {n}", n=3): the sentence in the current language, its {places} filled in either language. The first
argument is a string literal or a module constant (tests/test_i18n.py scans the sources for both and fails for every
Korean one with no English). Where a Korean particle goes by a name, the Korean sentence takes the name with its
particle as a place of its own ({name_ul}) and the English one the bare {name}.

What is NOT translated here, because the web parses it from storage and translates it for display: job progress
lines and error lines, check notes, a refused skeleton's reason, the wait texts the web mirrors (waits.py).
"""
from __future__ import annotations
import contextlib
import contextvars
import re

LANGS = ("ko", "en")
_current = contextvars.ContextVar("ipverse_lang", default="ko")
_HANGUL = re.compile(r"[가-힣]")


def norm(value) -> str:
    """ko unless the value says en."""
    return "en" if isinstance(value, str) and value.strip().lower() == "en" else "ko"


def use(value) -> str:
    """Set the language of what runs from here on (a request, a turn, a tick's session). → the language set."""
    lang = norm(value)
    _current.set(lang)
    return lang


def lang() -> str:
    return _current.get()


def from_event(event: dict) -> str:
    """The X-Lang header of a Lambda function URL event (header names arrive lower-cased; matched either way). An
    event that is no request (a self-invoke) says the language of the request that started it as "lang"."""
    headers = event.get("headers") if isinstance(event, dict) else None
    for k, v in (headers or {}).items():
        if isinstance(k, str) and k.lower() == "x-lang":
            return norm(v)
    return norm(event.get("lang")) if isinstance(event, dict) and not headers else "ko"


@contextlib.contextmanager
def speaking(value):
    """What is written inside is in this language; the language of what runs around it is as it was."""
    token = _current.set(norm(value))
    try:
        yield
    finally:
        _current.reset(token)


def remember(ctx, session: dict) -> None:
    """Keep on the session the language of the latest request that started work in it (called from those POSTs
    only): one write, and only when it changed."""
    from server import store
    if session and norm(session.get("lang")) != lang():
        store.set_lang(ctx, session, lang())


def tr(ko: str, lang_: str = None, **places) -> str:
    """The sentence in the language asked for (default: the current one), with its {places} filled."""
    text = EN.get(ko, ko) if (lang_ or _current.get()) == "en" else ko
    return text.format(**places) if places else text


_patterns = None


def _templates() -> list:
    """The sentences of EN that have {places}, each as a pattern of the text it makes, the most literal first."""
    global _patterns
    if _patterns is None:
        found = []
        for ko, en in EN.items():
            parts = re.split(r"\{(\w+)\}", ko)
            if len(parts) > 1 and len(set(parts[1::2])) == len(parts[1::2]):
                shape = "".join(re.escape(p) if i % 2 == 0 else f"(?P<{p}>.+?)" for i, p in enumerate(parts))
                found.append((sum(map(len, parts[::2])), re.compile(shape, re.S), en))
        _patterns = [(shape, en) for _, shape, en in sorted(found, key=lambda f: -f[0])]
    return _patterns


def said(text, lang_: str = None):
    """A sentence the server raised (a literal or an f-string, said through its error class) in the language: the
    sentence itself, else the EN template whose {places} it fills, each place said too. A template that would leave
    Korean in a place is skipped for the next one; a sentence none fits stays as it is, whole."""
    if (lang_ or _current.get()) != "en" or not isinstance(text, str) or not _HANGUL.search(text):
        return text
    if text in EN:
        return EN[text]
    for shape, en in _templates():
        filled = shape.fullmatch(text)
        if filled:
            places = {k: _place(v) for k, v in filled.groupdict().items()}
            if not any(_HANGUL.search(v) for v in places.values()):
                return en.format(**places)
    return text


def _place(value: str) -> str:
    """What fills a place of a raised sentence, in English where the server has English for it."""
    for say in (lambda v: span(v, "en"), lambda v: said(v, "en"), lambda v: LABELS.get(v, v), lambda v: DATA.get(v, v),
                lambda v: problem(v, "en")):
        if not _HANGUL.search(value):
            break
        value = say(value)
    return value


def label(ko: str, lang_: str = None) -> str:
    """A button, tab or step by the name the screen shows it under."""
    return LABELS.get(ko, ko) if (lang_ or _current.get()) == "en" else ko


def data(ko, lang_: str = None):
    """A value of one of the server's own tables (a seeded viewer's name, a platform service's name, a seeded game
    title) in the language: DATA. Anything else (a user's title, an IP's name) is itself."""
    return DATA.get(ko, ko) if (lang_ or _current.get()) == "en" and isinstance(ko, str) else ko


# The web's units: "{n} s", "{n} min", "{n} h"
_UNITS = (("시간", " h"), ("분", " min"), ("초", " s"))


def span(text: str, lang_: str = None) -> str:
    """A wait as waits.py writes it ("보통 4–7분", "약 3분", "20초–3분") in the language, numbers unchanged
    ("usually 4–7 min"). The Korean text is the one the web mirrors and stays as it is."""
    if (lang_ or _current.get()) != "en":
        return text
    out = re.sub(r"보통\s*", "usually ", text)
    out = re.sub(r"약\s*", "about ", out)
    for ko, en in _UNITS:
        out = re.sub(r"(\d)\s*" + ko, r"\1" + en, out)
    return out


def is_english(text: str) -> bool:
    """Whether a text reads as English: almost no Hangul in it."""
    letters = [c for c in text if c.isalpha()]
    return bool(letters) and sum(1 for c in letters if _HANGUL.match(c)) / len(letters) < 0.35


# The screen's names, the same as the web shows (tests/test_i18n.py reads the web's dictionaries and fails for a
# Korean name both sides have with different English)
LABELS = {
    "세션": "Session", "새 세션": "New session", "새 세션 시작": "Start a new session", "시작 화면": "Home",
    "최근 세션": "Recent sessions", "캐릭터": "Characters", "소품": "Props", "적": "Enemy", "무기": "Weapon",
    "배경": "Background", "영상": "Video", "샷": "Shot", "트레일러": "Trailer", "쇼츠": "Shorts", "게임": "Game",
    "채팅": "Chat", "작업 현황": "Jobs", "작업 기록": "Work log", "버전 기록": "Version history",
    "이 버전 쓰기": "Use this version", "다시 뽑기": "Redraw", "그림 다시 뽑기": "Redraw the picture",
    "수정하기": "Edit", "수정 요청": "Request edit", "3D로 만들기": "Make 3D", "3D용 자세 그림": "3D pose image",
    "3D 모델": "3D model", "움직임 뼈대": "Rig", "3D 회전 영상": "Turntable video", "배경 제거": "Cutout",
    "검사 실패": "Check failed", "적용 안 됨": "Not applied", "게임 설계": "Game design", "게임 만들기": "Make game",
    "게임에 반영": "Apply to game", "게임 시작": "Play", "크게 보기": "Expand", "이 게임 수정": "Edit this game",
    "게시하기": "Publish", "게시 내리기": "Unpublish", "주소 복사": "Copy link", "라이브 방송": "Live broadcast",
    "라이브 켜기": "Go live", "라이브 끄기": "End live", "플레이 창": "Play window", "시청 창": "Watch window",
    "가상 시청자": "Simulated viewers", "전체 화면 트레일러": "Full-screen trailer", "플레이어블 광고": "Playable ad",
    "코너 트레일러": "Corner trailer", "판": "Round", "광고": "Ad", "플레이어블 서버": "Playable server",
    "미리 켜기": "Pre-warm", "지금 내리기": "Shut down now", "고급 설정": "Advanced settings",
    "스킬 · 에이전트": "Skills · Agents", "장르 스킬": "Genre skills", "에이전트 등록": "Add agent",
    "받은 편지함": "Inbox", "테스트": "Test", "승인": "Approve", "거절": "Decline", "지금 실행": "Run now",
    "연결 설정": "Connections", "연결 서비스": "Connected services", "로그인": "Log in", "회원가입": "Sign up",
    "로그아웃": "Log out", "데모 로그인": "Demo login", "아이디": "ID", "비밀번호": "Password", "다시 시도": "Retry",
    "취소": "Cancel", "닫기": "Close", "저장": "Save", "삭제": "Delete", "세션 삭제": "Delete session",
    "새로고침": "Reload", "자동 저장됨": "Saved",
    # names only the server uses
    "3D": "3D", "계정": "Account", "중지": "Stop", "내려받기": "Download", "액션 샷": "Action shot",
    "영상 샷": "Video shot", "연출해서 만들기": "Direct a trailer", "다시 연출": "Direct again",
    "게임 설정": "Game settings", "미리보기": "Preview", "설계 요약": "Design summary",
    "플레이 창 열기": "Open play window", "브라우저 미리보기": "Browser preview", "상태 새로고침": "Refresh status",
    "내 플레이": "My play", "게임 보기": "View game", "배경 · 전체 장면": "Background · whole scene",
    # what 작업 기록 calls each tool (tools._LABELS): the button that does the same, else a plain name
    "컨셉 정하기": "Set concept", "캐릭터 만들기": "Make character", "소품 만들기": "Make prop",
    "무기 만들기": "Make weapon", "적 만들기": "Make enemy", "IP 만들기": "Make IP",
    "캐릭터 애니메이션": "Character animation", "트레일러 만들기": "Make trailer", "게임 설계 읽기": "Read game design",
    "장르 스킬 IP 만들기": "Make genre-skill IP", "영상 수정": "Edit video", "게임 파일 새로 고침": "Refresh game files",
    "게임 요청 보류": "Hold game request", "MCP 도구": "MCP tool",
    # the session's genres (gamespec.GENRE_LABELS) and the ad server's (adserver.GENRE_LABEL)
    "SF 슈터": "Sci-fi shooter", "SF 서바이벌": "Sci-fi survival", "RPG 탐험": "RPG exploration",
    "RPG 퀘스트": "RPG quest", "액션 RPG": "Action RPG", "레이싱": "Racing", "탐험·수집": "Explore & collect",
    "서바이벌": "Survival", "플랫포머": "Platformer",
    # words of the prompt and the tools that the screen says otherwise (agent.WORD_LABELS)
    "묘사": "description", "GPU 서버": "GPU server",
}

# English for the server's own sentences, keyed by the Korean sentence exactly as it is passed to tr()
EN = {
    # ── app.py: the API's refusals ──
    "요청을 읽지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.": "The request could not be read. Reload the page and try again.",
    "세션을 찾지 못했어요. 목록에서 다시 골라 주세요.": "That session was not found. Pick it again from the list.",
    "장르를 목록에서 다시 골라 주세요.": "Pick the genre again from the list.",
    "세션 제목을 적어 주세요.": "Enter a session title.",
    "라이브 방송 중인 세션은 지울 수 없어요. 방송을 끈 뒤 다시 시도해 주세요.":
        "A session that is live cannot be deleted. End the broadcast and try again.",
    "진행 중인 작업 {n}건이 있어 지울 수 없어요. 작업 현황에서 중지하거나 끝난 뒤 다시 시도해 주세요.":
        "Jobs still in progress: {n}. Stop them in Jobs, or try again when they finish.",
    "답변을 만드는 중이에요. 답변이 끝난 뒤 다시 시도해 주세요.": "A reply is being written. Try again when it is done.",
    "보낼 내용을 적어 주세요.": "Type a message to send.",
    "메시지가 너무 길어요. {limit}자 안으로 줄여 다시 보내 주세요.":
        "That message is too long. Shorten it to {limit} characters and send it again.",
    "요청을 시작하지 못했어요. 다시 보내 주세요.": "The request could not be started. Send it again.",
    "이 버튼은 지금 쓸 수 없어요. 화면을 새로 고친 뒤 다시 눌러 주세요.":
        "This button cannot be used right now. Reload the page and press it again.",
    "작업을 시작하지 못했어요. 다시 눌러 주세요.": "The job could not be started. Press it again.",
    "잠시 뒤 다시 눌러 주세요.": "Press it again in a moment.",
    "다시 뽑는 중…": "Redrawing…",
    "액션 샷 준비 중…": "Preparing the action shot…",
    "장르 스킬 IP 만드는 중… (그림 → 3D)": "Making the genre-skill IP… (picture → 3D)",
    "이 작업은 이미 끝났거나 중지돼서 중지할 수 없어요.": "This job has already ended or been stopped, so it cannot be stopped.",
    "실패한 작업만 다시 시도할 수 있어요. 이 작업은 이미 다시 돌고 있거나 끝났어요.":
        "Only a failed job can be retried. This one is already running again or has ended.",
    "아이디는 영문·숫자·_.- 3–32자로 입력해 주세요": "Enter an ID of 3–32 letters, digits or _.-",
    "비밀번호는 대·소문자, 숫자, 특수문자를 넣어 12자 이상으로 적어 주세요.":
        "Enter a password of 12 or more characters with upper and lower case, a digit and a symbol.",
    "이미 있는 아이디예요. 다른 아이디를 써 주세요": "That ID is taken. Use another one",
    "비밀번호는 12자 이상, 대·소문자, 숫자, 특수문자를 모두 넣어 주세요":
        "The password needs 12 or more characters with upper and lower case, a digit and a symbol",
    "지금 켜 둔 내 방송이 없어요. 라이브를 켠 뒤 다시 시도해 주세요.": "You have no broadcast on air. Go live and try again.",
    "게임을 찾지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.": "That game was not found. Reload the page and try again.",
    "연결 정보가 올바르지 않아요. 페이지를 새로 고친 뒤 다시 해 주세요.":
        "The connection details are not valid. Reload the page and try again.",
    "연결이 이미 끝났어요. 다시 시작해 주세요.": "That connection has already ended. Start it again.",
    "요청한 기능을 찾지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.":
        "That feature was not found. Reload the page and try again.",
    "지금은 클라우드 플레이 자리가 없어요. 잠시 뒤 다시 시도해 주세요.": "No cloud play seat is free right now. Try again in a moment.",
    "지금은 체험 자리가 없어요. 잠시 뒤 다시 시도해 주세요.": "No trial seat is free right now. Try again in a moment.",
    "클라우드 서버에 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.": "The cloud server had a problem. Try again in a moment.",
    "서버에서 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.": "Something went wrong on the server. Try again in a moment.",
    # ── agent.py: the lines the server puts into the chat ──
    "완료했어요.": "Done.",
    "한 번에 할 수 있는 일을 다 써서 여기서 멈췄어요. ‘이어서 해줘’라고 보내 주세요.":
        "I did as much as one turn allows and stopped here. Send ‘continue’ to go on.",
    "시간이 오래 걸려 여기서 멈췄어요. ‘이어서 해줘’라고 보내 주세요.": "This took too long, so I stopped here. Send ‘continue’ to go on.",
    "답변이 너무 길어져 끝까지 쓰지 못했어요. 요청을 나눠서 다시 보내 주세요.":
        "The reply got too long to finish. Split the request and send it again.",
    "죄송해요, 요청을 처리하지 못했어요. 잠시 뒤 같은 요청을 다시 보내 주세요. 만들어 둔 그림과 작업은 그대로 있어요.":
        "Sorry, the request could not be completed. Send the same request again in a moment. The pictures and jobs made so far are still there.",
    "응답이 너무 오래 걸려 중단됐어요. 다시 요청해 주세요.": "The reply took too long and was stopped. Ask again.",
    "MCP 도구: {server} · {tool}": "MCP tool: {server} · {tool}",
    "{label} 실패: {why}": "{label} failed: {why}",
    "‘작업 현황’ 탭에서 이유와 다음에 할 일을 볼 수 있어요.": "The ‘Jobs’ tab shows the reason and what to do next.",
    "트레일러를 만들지 못했어요. {where}": "The trailer could not be made. {where}",
    "트레일러와 쇼츠가 완성됐어요. ‘영상’ 탭에서 볼 수 있어요.": "The trailer and shorts are ready. Watch them in the ‘Video’ tab.",
    "트레일러가 완성됐어요. ‘영상’ 탭에서 볼 수 있어요.": "The trailer is ready. Watch it in the ‘Video’ tab.",
    "요청해 둔 게임은 ‘{button}’ 버튼으로 지금 만들 수 있고, 걷는 동작 없이 나와요.":
        "The game you asked for can be made now with the ‘{button}’ button, and it plays without walking motions.",
    "이대로 게임을 만들면 걷는 동작 없이 나와요.": "A game made with it as it is plays without walking motions.",
    "{name}의 {mesh_un} 준비됐지만 {rig_un} 넣지 못했어요: {reason}. {game} {redraw}":
        "{name}'s {mesh} is ready, but the {rig} could not be added: {reason}. {game} {redraw}",
    "걷는 동작을 넣으려면 {needs}으로 다시 뽑은 뒤 3D를 다시 만들어 주세요.":
        "For walking motions, redraw it as {needs}, then make the 3D again.",
    "머리부터 발끝까지 보이고 두 다리가 드러나게 서 있는 그림": "a picture that shows the figure from head to toe, standing with both legs in view",
    "{name}의 {mesh_un} 준비됐지만 {step} 단계가 실패했어요. {where}": "{name}'s {mesh} is ready, but the {step} step failed. {where}",
    "{name}의 3D를 만들지 못했어요({step} 단계에서 실패). {where}": "{name}'s 3D could not be made (the {step} step failed). {where}",
    "{name}의 3D를 만들지 못했어요. {where}": "{name}'s 3D could not be made. {where}",
    "{name}의 3D가 준비됐어요. ‘3D’ 탭에서 돌려 볼 수 있어요.": "{name}'s 3D is ready. Turn it around in the ‘3D’ tab.",
    "요청해 둔 게임은 ‘{button}’ 버튼으로 만들 수 있어요.": "The game you asked for can be made with the ‘{button}’ button.",
    # ── tools.py: a card button's refusals (toasts), 작업 기록 and the chat lines of a button ──
    "배경은 걸어 다닐 수 있는 3D 대신 두께만 준 그림 판과 {step_ro} 만들어요({wait}).":
        "A background becomes a relief panel with thickness only and its {step}, not a 3D space to walk in ({wait}).",
    "구도 검사를 통과하지 못한 그림이라 3D도 그 모양대로 나오니 다시 뽑아 보세요.":
        "This picture did not pass the composition check, so its 3D comes out the same way. Try a redraw.",
    "수정 검사를 통과하지 못한 그림이라 3D도 그 모습대로 나오니 다시 뽑아 보세요.":
        "This picture did not pass the edit check, so its 3D comes out the same way. Try a redraw.",
    "첫 그림이 구도 검사를 통과하지 못했으니 다시 뽑아 보세요.": "The first picture did not pass the composition check. Try a redraw.",
    "이 영상 모델은 지금 쓸 수 없으니 잠시 뒤 다시 누르거나 채팅에서 다른 모델로 요청해 주세요.":
        "This video model is not available right now. Press again in a moment or ask for another model in the chat.",
    "화면이 오래돼 {what_ul} 찾지 못했으니 새로 고친 뒤 다시 해 주세요.": "This screen is out of date. Reload and try again.",
    "요청을 처리하지 못했으니 화면을 새로 고친 뒤 다시 해 주세요.": "The request could not be completed. Reload the page and try again.",
    "{label_ul} 시작하지 못했어요. {why}": "{label} could not be started. {why}",
    "{names}의 그림을 만들지 못했으니 ‘작업 현황’에서 그림 작업을 다시 시도해 주세요.":
        "The picture of {names} could not be made. Retry the picture job in ‘Jobs’.",
    "{names}의 그림을 아직 그리는 중이니(약 {minutes}분) 그림이 나온 뒤 다시 눌러 주세요.":
        "The picture of {names} is still being drawn (about {minutes} min). Press again when it is in.",
    "{name}에는 {step_ul} 넣지 않아요(캐릭터와 사람형 적에만 넣어요).":
        "{name} cannot have a {step} (only characters and humanoid enemies can).",
    "{name}의 {step_i} 아직 없으니 ‘{button}’를 먼저 눌러 주세요.": "{name} has no {step} yet. Press ‘{button}’ first.",
    "광고로 고른 영상을 찾지 못했으니 게시 창을 닫았다가 다시 열어 골라 주세요.":
        "The video picked as the ad was not found. Close the publish dialog, open it again and pick one.",
    "건너뛰기 버튼 표시까지의 시간은 0–30초 사이로 적어 주세요.": "Enter 0–30 s for the time until the skip button shows.",
    "광고 다시 틀기는 0–20판 사이로 적어 주세요(0이면 시작할 때만 틀어요).":
        "Enter 0–20 rounds for replaying the ad (0 plays it only at the start).",
    "이 버전은 배경을 지운 그림이 없어 지금 그림으로 쓸 수 없어요.":
        "This version has no picture with its background removed, so it cannot be the current picture.",
    "{label}: {name} v{version}. 이제 이 버전이 지금 그림이에요{failed}.": "{label}: {name} v{version}. This version is the current picture now{failed}.",
    "{name}의 새 그림을 이미 그리는 중이니 끝난 뒤 다시 눌러 주세요.":
        "A new picture of {name} is already being drawn. Press again when it is done.",
    "이 그림은 다시 뽑을 기록이 없으니 ‘{button}’로 바꾸거나 채팅에서 새로 그려 달라고 해 주세요.":
        "This picture has no record to redraw from. Change it with ‘{button}’ or ask for a new drawing in the chat.",
    "새 그림(v{version})은 검사를 통과하지 못해 버전 기록에만 두었어요.":
        "The new picture (v{version}) did not pass its check and is kept in Version history only.",
    "입력값이 맞지 않았어요": "The input was not valid",
    "주인공의 3D가 아직 끝나지 않았어요": "The hero's 3D is not finished yet",
    "그림을 아직 그리는 중이에요": "A picture is still being drawn",
    "새 그림을 이미 그리는 중이에요": "A new picture is already being drawn",
    "그림을 만들지 못했어요": "The picture could not be made",
    "찾지 못했어요": "It was not found",
    "3D가 이미 끝났어요": "The 3D is already finished",
    "그림이 검사를 통과하지 못했어요": "The picture did not pass its check",
    "무기의 3D가 아직 없어요": "The weapon has no 3D yet",
    "배경 사물의 3D가 아직 없어요": "A set piece has no 3D yet",
    "지금은 이 기능을 쓸 수 없어요": "This is not available right now",
    "요청을 처리하지 못했어요": "The request could not be completed",
    # ── providers/mediagen_image.py: an edit kept out of the IP, told in the chat ──
    "{name}의 수정한 그림(v{version})은 수정 검사를 통과하지 못해 쓰지 않았어요. 이유: {problem}. 지금 그림(v{kept})은 그대로예요. "
    "새 그림도 카드의 버전 기록에 있어서, 마음에 들면 거기서 골라 쓸 수 있어요. {then}":
        "The edited picture of {name} (v{version}) did not pass the edit check and was not used. Reason: {problem}. "
        "The current picture (v{kept}) is as it was. The new picture is in the card's Version history too, so you can "
        "pick it there if you like it. {then}",
    "바꿀 점을 더 좁혀 다시 요청하거나, ‘기본 모델로 다시 수정해줘’라고 말해 주세요.":
        "Ask again with a narrower change, or say ‘retry with the default model’.",
    "바꿀 점을 더 좁혀 다시 요청하거나, ‘다른 모델로 다시 수정해줘’라고 말해 주세요.":
        "Ask again with a narrower change, or say ‘retry with another model’.",
    "바꿀 점을 더 좁혀 다시 요청해 주세요(예: ‘배경은 그대로 두고 망토만 빨갛게’).":
        "Ask again with a narrower change (for example ‘keep the background and make only the cape red’).",
    # ── game_design.py: the game design drawer's toast ──
    "고른 IP 중에 이 세션에 없는 것이 있어요. 게임 설계 창에서 출연 IP를 다시 골라 주세요.":
        "One of the picked IPs is not in this session. Pick the cast again in Game design.",
    "게임 설계를 읽지 못했어요. 게임 설계 창을 닫았다가 다시 열어 주세요.": "The game design could not be read. Close Game design and open it again.",
    "게임 아이디어를 {limit}자 안으로 적어 주세요.": "Write the game idea in {limit} characters or fewer.",
    "게임 설계와 보낸 메시지가 서로 달라요. 게임 설계 창에서 다시 보내 주세요.":
        "The game design and the message sent do not match. Send it again from Game design.",
    "IP는 한 역할에 {n}개까지 고를 수 있어요.": "A role takes up to {n} IPs.",
    "같은 IP가 한 역할에 두 번 들어 있어요. 출연 IP를 다시 골라 주세요.": "The same IP is in one role twice. Pick the cast again.",
    "NPC·동료는 1명까지 고를 수 있어요.": "Only one NPC or companion can be picked.",
    "주인공을 하나 골라 주세요.": "Pick one hero.",
    "고른 IP마다 역할을 하나씩 정해 주세요.": "Give every picked IP one role.",
    "한 IP에는 역할을 하나만 줄 수 있어요.": "An IP can have only one role.",
    "역할을 준 IP를 출연 IP로도 골라 주세요.": "Also pick the IPs that have a role as cast.",
    "배경(장면 전체)은 주인공이 될 수 없어요. 다른 IP를 주인공으로 골라 주세요.":
        "A background (a whole scene) cannot be the hero. Pick another IP as the hero.",
    "주인공 무기는 무기 IP 중에서 골라 주세요.": "Pick the hero's weapon from the weapon IPs.",
    "배경·환경은 소품 IP 중에서 골라 주세요.": "Pick the background from the prop IPs.",
    "배경 사물은 소품 IP 중에서 골라 주세요.": "Pick set pieces from the prop IPs.",
    # ── connections.py ──
    "지금은 응답이 없어요. 잠시 뒤 ‘상태 새로고침’을 눌러 주세요.": "No answer right now. Press ‘Refresh status’ in a moment.",
    "인증이 필요하거나 거부됐어요 (HTTP {code}). 인증 헤더와 값을 확인해 주세요.":
        "Authentication is required or was refused (HTTP {code}). Check the auth header and its value.",
    "MCP 서버 응답이 아니에요 (HTTP {code}). 주소가 MCP 엔드포인트인지 확인해 주세요.":
        "That is not an MCP server's answer (HTTP {code}). Check that the address is an MCP endpoint.",
    "시간 안에 응답하지 않았어요": "It did not answer in time",
    "MCP 서버 주소를 입력해 주세요.": "Enter the MCP server's address.",
    "MCP 서버 주소는 https://로 시작해야 해요.": "The MCP server's address must start with https://.",
    "{host} 주소를 찾지 못했어요. 주소를 다시 확인해 주세요.": "The address {host} was not found. Check the address again.",
    "내부 주소로는 연결할 수 없어요. 밖에서 열리는 주소를 넣어 주세요.":
        "Internal addresses cannot be used. Enter a publicly reachable address.",
    "이름은 1–40자로 입력해 주세요": "Enter a name of 1–40 characters",
    "인증 헤더 이름이나 인증 값이 올바르지 않아요. 다시 확인해 주세요.": "The auth header's name or value is not valid. Check them again.",
    "MCP 서버는 {n}개까지 연결할 수 있어요": "Up to {n} MCP servers can be connected",
    "주소와 인증 값을 확인한 뒤 다시 해 주세요.": "Check the address and the auth value and try again.",
    "MCP 서버에 연결하지 못했어요. {told}": "The MCP server could not be connected. {told}",
    "연결을 찾지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.": "That connection was not found. Reload the page and try again.",
    # ── streams.py, playable.py: cloud play and a playable ad's trial ──
    "이 세션의 클라우드 플레이를 다른 창(또는 기기)에서 시작해서 이 창의 스트림은 닫았어요. 여기서 계속하려면 다시 시도를 누르세요":
        "This session's cloud play was started in another window (or device), so this window's stream was closed. Press Retry to go on here",
    "지금은 클라우드 GPU {n}대가 모두 사용 중이에요. 다른 창이나 다른 사람의 클라우드 플레이가 끝나면 다시 시도해 주세요. "
    "바로 하려면 ‘브라우저 미리보기’로 플레이할 수 있어요":
        "Every cloud GPU is in use right now (in use: {n}). Try again when a cloud play in another window or by "
        "another person ends. To play right away, use ‘Browser preview’",
    "클라우드 플레이 연결이 이미 끝났어요. 다시 시작해 주세요.": "That cloud play connection has already ended. Start it again.",
    "Unreal 플레이가 아직 준비되지 않았어요. 관리자에게 문의해 주세요.": "Unreal play is not set up yet. Contact the administrator.",
    "클라우드 플레이가 아직 설정되지 않았어요. 관리자에게 문의해 주세요.": "Cloud play is not configured yet. Contact the administrator.",
    "클라우드 플레이가 아직 준비되지 않았어요. 관리자에게 문의해 주세요.": "Cloud play is not ready yet. Contact the administrator.",
    "Unreal로 만든 게임이 없어요. 채팅에서 Unreal 게임을 먼저 만들어 달라고 해 주세요.":
        "There is no game made with Unreal. Ask for an Unreal game in the chat first.",
    "클라우드로 플레이할 게임이 없어요. 먼저 게임을 만들어 주세요.": "There is no game to play in the cloud. Make a game first.",
    "지금은 체험할 자리가 모두 찼어요 (클라우드 GPU {n}대 사용 중). {wait} 뒤 다시 눌러 주세요":
        "Every trial seat is taken right now (cloud GPUs in use: {n}). Press again in {wait}",
    "이 대기 세션은 이미 끝났어요": "This standby session has already ended",
    "체험 길이는 {lo}–{hi}초 사이에서 골라 주세요.": "Pick a trial length of {lo}–{hi} s.",
    "광고로 만들 게임을 골라 주세요.": "Pick a game to make the ad from.",
    "이 광고의 게임이 삭제됐어요": "This ad's game was deleted",
    "광고를 찾지 못했어요. 주소를 다시 확인해 주세요.": "That ad was not found. Check the address again.",
    "체험 연결이 이미 끝났어요. 다시 시작해 주세요.": "That trial connection has already ended. Start it again.",
    "지금은 미리 연결해 둘 수 없는 광고예요. 누르면 바로 시작해요": "This ad cannot be pre-connected right now. It starts when you press it",
    "이 체험은 창이 닫혀서 시작하지 않았어요": "This trial did not start because its window was closed",
    "체험을 기다리는 시청자가 있어요. 지금 대기 {n}번째예요.": "Viewers are waiting for a trial. You are number {n} in line.",
    "잘못된 대기 세션이에요": "That standby session is not valid",
    "대기 세션이 끝났어요": "The standby session has ended",
    "대기 세션을 찾을 수 없어요": "That standby session was not found",
    "이 대기 세션은 이미 다른 게임을 열었어요": "This standby session has already opened another game",
    "이 대기 세션은 이미 쓰였어요": "This standby session has already been used",
    "서명이 맞지 않는 지시예요": "That instruction's signature does not match",
    "지시가 만료됐어요": "That instruction has expired",
    # ── ads.py, live.py: the broadcast console, the play window and the watch window ──
    "없는 시청자예요": "There is no such viewer",
    "광고 노출 기록을 읽지 못했어요.": "The ad impression could not be read.",
    "방송을 볼 준비가 아직 끝나지 않았어요. 관리자에게 문의해 주세요.": "Watching a broadcast is not set up yet. Contact the administrator.",
    "전체 화면 트레일러를 준비하고 있어요({wait}). 이번 판은 코너 트레일러를 보냈어요.":
        "The full-screen trailer is being prepared ({wait}). This round got a corner trailer.",
    "전체 화면 트레일러는 시청 창을 열어 두면 준비를 시작해요({wait}). 이번 판은 코너 트레일러를 보냈어요.":
        "The full-screen trailer starts preparing once a watch window is open ({wait}). This round got a corner trailer.",
    "이 세션의 라이브가 켜져 있지 않아요. 라이브를 켠 뒤 다시 해 주세요.": "This session is not live. Go live and try again.",
    "이 방송은 다른 방송으로 바뀌었어요.": "This broadcast was replaced by another one.",
    "이 환경에는 라이브 방송이 설치되어 있지 않아요. 관리자에게 문의해 주세요.":
        "Live broadcast is not installed in this environment. Contact the administrator.",
    "방송 상태가 동시에 바뀌고 있어요. 잠시 뒤 다시 시도해 주세요": "The broadcast is being changed at the same time. Try again in a moment",
    "라이브 방송 채널을 찾지 못했어요. 관리자에게 문의해 주세요.": "The live channel was not found. Contact the administrator.",
    "광고 구간을 넣지 못했어요. 방송이 켜져 있는지 확인한 뒤 다시 보내 주세요.":
        "The ad break could not be inserted. Check that the broadcast is live and send it again.",
    "다른 광고가 나가는 중이에요. 잠시 뒤 다시 보내 주세요": "Another ad is on air. Send it again in a moment",
    "판이 끝나는 시간이 바뀌어 광고 구간을 미리 보내지 않았어요": "The round's end time changed, so the ad break was not sent ahead",
    "방송에 실어 보낼 내용이 너무 길어요. 제목을 줄인 뒤 다시 보내 주세요.":
        "That is too long to send on the broadcast. Shorten the title and send it again.",
    "지금은 미리 연결해 둘 수 없어요. 누르면 그때 시작해요": "It cannot be pre-connected right now. It starts when you press it",
    "이 세션의 방송이 아니에요": "That is not this session's broadcast",
    "이 광고 구간에 이 시청자의 광고가 없어요": "This ad break has no ad for this viewer",
    "광고 기록을 읽지 못했어요. 시청 창을 새로 고쳐 주세요.": "The ad event could not be read. Reload the watch window.",
    "광고를 본 시간을 읽지 못했어요. 시청 창을 새로 고쳐 주세요.": "The ad's watch time could not be read. Reload the watch window.",
    "코너 트레일러 설정을 읽지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.":
        "The corner trailer setting could not be read. Reload the page and try again.",
    "광고를 미리 보내는 시간은 0–20초 사이로 적어 주세요(0은 미리 보내지 않아요).":
        "Enter 0–20 s for sending the ad ahead (0 does not send it ahead).",
    "다른 사용자가 방송 중이에요. 끝난 뒤(최대 {minutes}분) 다시 시도해 주세요.":
        "Another user is live. Try again when they are done (at most {minutes} min).",
    "내 다른 세션에서 방송 중이에요. 그 방송을 먼저 꺼 주세요.": "You are live in another session. End that broadcast first.",
    "다른 사용자가 방송 중이라 플레이어블 서버를 바꿀 수 없어요. 방송이 끝난 뒤 다시 시도해 주세요.":
        "Another user is live, so the playable server cannot be changed. Try again when the broadcast ends.",
    "게임이 있는 세션에서만 플레이어블 서버를 켜거나 내릴 수 있어요. 먼저 게임을 만들어 주세요.":
        "The playable server can be started or shut down only in a session that has a game. Make a game first.",
    "‘라이브 켜기’가 겹쳤어요. 잠시 뒤 다시 눌러 주세요.": "‘Go live’ was pressed twice at once. Press it again in a moment.",
    "방송할 게임이 없어요. 먼저 게임을 만들어 주세요.": "There is no game to broadcast. Make a game first.",
    "광고로 쓸 트레일러가 없어요. 먼저 트레일러를 만들거나 플레이어블 광고를 골라 주세요.":
        "There is no trailer to use as an ad. Make a trailer first or pick the playable ad.",
    "지금은 ‘내 플레이’ 방송만 켤 수 있어요.": "Only a ‘My play’ broadcast can go live right now.",
    "광고 방식을 전체 화면 트레일러, 플레이어블 광고, 코너 트레일러 중에서 골라 주세요.":
        "Pick the ad style: full-screen trailer, playable ad or corner trailer.",
    "광고 간격은 1–20판 사이로 적어 주세요.": "Enter an ad interval of 1–20 rounds.",
    "끝난 판 수를 읽지 못했어요. 플레이 창을 새로 고쳐 주세요.": "The number of finished rounds could not be read. Reload the play window.",
    "몇 번째 판인지 읽지 못했어요. 플레이 창을 새로 고쳐 주세요.": "The round's number could not be read. Reload the play window.",
    "판이 끝날 시간을 읽지 못했어요. 플레이 창을 새로 고쳐 주세요.": "The round's end time could not be read. Reload the play window.",
    "기본 광고 (시청자 정보 없음)": "Default ad (no viewer data)",
    "기본 코너 광고 (시청자 정보 없음)": "Default corner ad (no viewer data)",
    "기본 플레이어블 (시청자 정보 없음)": "Default playable (no viewer data)",
    "맞춤 트레일러가 없어 기본 트레일러": "No matching trailer, so the default trailer",
    "추천할 게임이 없어 이 방송의 게임": "No game to recommend, so this broadcast's game",
    "준비된 맞춤 광고가 없어 기본 광고": "No matching ad is ready, so the default ad",
    "준비 중": "preparing",
    "길이 초과": "too long",
    "플레이어블 서버 상태를 읽지 못했어요. 잠시 뒤 다시 시도해 주세요.": "The playable server's state could not be read. Try again in a moment.",
    "플레이어블 서버 설정을 읽지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.":
        "The playable server setting could not be read. Reload the page and try again.",
    "플레이어블 서버를 켜지 못했어요. 잠시 뒤 다시 눌러 주세요.": "The playable server could not be started. Press again in a moment.",
    "플레이어블 서버를 내리지 못했어요. 잠시 뒤 다시 눌러 주세요.": "The playable server could not be shut down. Press again in a moment.",
    "하이라이트 자동 생성이 꺼져 있어요. 고급 설정에서 켠 뒤 다시 해 주세요.":
        "Automatic highlights are off. Turn them on in Advanced settings and try again.",
    "판의 시작과 끝 시간을 읽지 못했어요. 플레이 창을 새로 고쳐 주세요.":
        "The round's start and end times could not be read. Reload the play window.",
    "1초도 안 되는 판은 하이라이트로 만들지 않아요.": "A round shorter than 1 s is not made into a highlight.",
    "이 하이라이트를 방송에 내보낼 준비를 하고 있어요. {wait} 뒤에 보내 주세요.":
        "This highlight is being prepared for the broadcast. Send it in {wait}.",
    "하이라이트를 방송에 띄우지 못했어요. 방송이 켜져 있는지 확인한 뒤 다시 보내 주세요.":
        "The highlight could not be shown on the broadcast. Check that the broadcast is live and send it again.",
    "하이라이트를 보낼 방식을 다시 골라 주세요.": "Pick again how to send the highlight.",
    "아직 준비 중이거나 지운 하이라이트라 보낼 수 없어요.": "This highlight is still being prepared or was deleted, so it cannot be sent.",
    "하이라이트를 찾지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.": "That highlight was not found. Reload the page and try again.",
    "트레일러가 없는 방송이에요. 트레일러 광고로 바꾸려면 트레일러를 만든 뒤 방송을 다시 켜 주세요":
        "This broadcast has no trailer. To switch to trailer ads, make a trailer and go live again",
    "하이라이트 설정을 읽지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.":
        "The highlight setting could not be read. Reload the page and try again.",
    "하이라이트를 자동으로 보낼 방식을 다시 골라 주세요.": "Pick again how highlights are sent automatically.",
    "{round}판 명장면": "Round {round} highlight",
    "IPverse 하이라이트 · {round}판": "IPverse highlight · round {round}",
    # ── adserver.py: why a viewer got an ad (the watch window's reasons, written per break) ──
    "최근 7일 {label} {hours}": "{label} for {hours} in the last 7 days",
    " ({wins}승)": " (wins: {wins})",
    "{label} 광고 클릭 {n}회": "{label} ad clicks: {n}",
    "{label} 게임 구매 {n}회": "{label} purchases: {n}",
    "{label} 게임 찜 {n}회": "{label} wishlists: {n}",
    "{label} 방송 시청 {hours}": "Watched {label} broadcasts for {hours}",
    "관심 장르 {label}": "Likes the genre {label}",
    "'{tag}' 좋아함": "Likes '{tag}'",
    "IP '{ip}' 반응": "Reacted to the IP '{ip}'",
    "{label} 플레이어블 체험 {n}회": "{label} playable trials: {n}",
    "아직 안 해 본 게임": "A game not tried yet",
    "처음 보는 광고": "An ad not seen before",
    "{label} 광고 스킵 {n}회 (감점)": "{label} ad skips: {n} (penalty)",
    "새로운 장르 탐색": "Exploring a new genre",
    "차선 · 1순위 '{title}' {note}": "Second choice · first choice '{title}' {note}",
    # ── viewers.py: a simulated viewer's activity lines ──
    "{genre} · {title} {minutes}분 플레이 (승리)": "{genre} · played {title} for {minutes} min (won)",
    "{genre} · {title} {minutes}분 플레이 (패배)": "{genre} · played {title} for {minutes} min (lost)",
    "방송 시청 {minutes}분 · {title}": "Watched the broadcast for {minutes} min · {title}",
    "플레이어블 광고 {played}": "Playable ad {played}",
    "코너 광고 크게 보기": "Corner ad expanded",
    "코너 광고 소리 켬": "Corner ad unmuted",
    "트레일러 시청": "Watched a trailer",
    "광고 노출": "Ad shown",
    "광고 클릭": "Ad clicked",
    "광고 스킵": "Ad skipped",
    "구매": "Purchase",
    "찜": "Wishlist",
    "코너 광고 노출": "Corner ad shown",
    "코너 광고 → 게임 보기": "Corner ad → View game",
    "플레이어블 카드 노출": "Playable card shown",
    "플레이어블 광고 시작": "Playable ad started",
    # ── agents.py: the agents' list, the registration dialog, the scout's notes ──
    "일정 ‘{expr}’은(는) 읽지 못했어요. {forms}": "The schedule ‘{expr}’ could not be read. {forms}",
    "한 시간에 한 번보다 자주 돌릴 수는 없어요. 분은 0이나 30처럼 숫자로 정해 주세요. {forms}":
        "An agent cannot run more often than once an hour. Set the minute as a number such as 0 or 30. {forms}",
    "오픈웨이트 모델 스카우트": "Open-weight model scout",
    "매일 아침 Hugging Face Hub에서 새로 나왔거나 갱신된 오픈웨이트 이미지(텍스트→이미지, 레퍼런스 이미지 편집)·영상"
    "(텍스트·이미지→영상) 생성 모델을 조사한다. 오픈 라이선스(비상업 라이선스는 표시), L40S 48 GB GPU 한 장에 들어가는지"
    "(아니면 필요한 인스턴스), diffusers나 공식 추론 코드가 있는지 확인하고, 지금 쓰는 Krea 2 Turbo·FLUX.2 klein 9B·"
    "LTX-2.5·Wan2.2·MiniMax H3·Kandinsky 6.0 Pro보다 나은 모델만 제안한다. 이미 제안·테스트·승인한 모델은 다시 제안하지 "
    "않는다. 테스트를 누르면 GPU에 실제로 설치해 같은 프롬프트로 비교하고, 승인하면 다음 요청부터 그 모델을 고를 수 있다.":
        "Every morning it looks on the Hugging Face Hub for new or updated open-weight image (text to image, editing "
        "with a reference image) and video (text or image to video) models. It checks for an open license (a "
        "non-commercial one is marked), whether the model fits one L40S 48 GB GPU (or which instance it needs) and "
        "whether diffusers or official inference code exists, and proposes only models better than the ones in use: "
        "Krea 2 Turbo, FLUX.2 klein 9B, LTX-2.5, Wan2.2, MiniMax H3 and Kandinsky 6.0 Pro. A model already proposed, "
        "tested or approved is not proposed again. Test installs it on a GPU and compares it on the same prompts; "
        "Approve makes it selectable from the next request on.",
    "에이전트를 찾지 못했어요. 목록을 새로 고친 뒤 다시 해 주세요.": "That agent was not found. Reload the list and try again.",
    "에이전트는 Hugging Face 모델 찾기, 공개 웹 페이지 읽기와 웹 검색, 받은 편지함으로 알리기만 할 수 있어요.":
        "An agent can only look up Hugging Face models, read public web pages, search the web and post to the Inbox.",
    "맡길 일을 한 문장으로 적어 주세요.": "Describe the job in a sentence.",
    "맡길 일이 너무 길어요. 4,000자 안으로 줄여 주세요.": "That description is too long. Shorten it to 4,000 characters.",
    "에이전트를 만들지 못했어요. 잠시 뒤 다시 눌러 주세요.": "The agent could not be made. Press again in a moment.",
    "이 일은 지금 에이전트에게 맡길 수 없어요: {cannot} {can_do} 할 일을 바꿔 다시 적어 주세요.":
        "An agent cannot do this right now: {cannot} {can_do} Change the job and write it again.",
    "에이전트의 이름이나 할 일이 비어서 만들지 못했어요. 다시 눌러 주세요.":
        "The agent's name or job came out empty, so it was not made. Press again.",
    "기본 에이전트의 이름과 할 일은 바꿀 수 없어요. 일정과 켜기·끄기만 바꿀 수 있어요.":
        "The built-in agent's name and job cannot be changed. Only its schedule and on/off can.",
    "이름을 1–{limit}자로 적어 주세요.": "Enter a name of 1–{limit} characters.",
    "할 일을 1–{limit}자로 적어 주세요.": "Enter a job of 1–{limit} characters.",
    "켜기·끄기 값을 읽지 못했어요. 화면을 새로 고친 뒤 다시 눌러 주세요.": "The on/off value could not be read. Reload the page and press again.",
    "기본 에이전트는 지울 수 없어요. 끄기로 멈출 수 있어요.": "The built-in agent cannot be deleted. Turn it off to stop it.",
    "실행 중…": "Running…",
    "이번 실행은 끝내지 못했어요. 잠시 뒤 ‘지금 실행’으로 다시 해 주세요.": "This run did not finish. Try again with ‘Run now’ in a moment.",
    "제안을 찾지 못했어요. 받은 편지함을 새로 고친 뒤 다시 해 주세요.": "That proposal was not found. Reload the Inbox and try again.",
    "이미지": "image",
    "이미지 (레퍼런스 편집 가능)": "image (can edit with a reference)",
    "영상": "video",
    "약 {gb} GB(bf16 추정)": "about {gb} GB (bf16 estimate)",
    "모델 카드에 크기 정보 없음": "no size on the model card",
    "L40S 48 GB 한 장에 들어감": "fits one L40S 48 GB",
    "L40S 한 장을 넘음(오프로드/멀티 GPU 필요)": "larger than one L40S (needs offload or several GPUs)",
    "상업 이용 가능": "commercial use allowed",
    "상업 이용 불가 또는 조건부(확인 필요)": "no commercial use, or conditional (check it)",
    "- 왜 더 나은가: {why}\n- 위험: {risks}\n": "- Why it is better: {why}\n- Risks: {risks}\n",
    "- VRAM: {vram} · {fits} · 인스턴스 {instance}\n- 라이선스: {lic}\n": "- VRAM: {vram} · {fits} · instance {instance}\n- License: {lic}\n",
    "- 추론 경로: {inference}\n": "- Inference: {inference}\n",
    "**테스트**를 누르면 {instance}(시간당 약 ${cost}, 최대 {hours}시간)에 모델을 설치해 지금 모델과 같은 프롬프트로 결과를 만들어 "
    "비교합니다. 통과하면 **승인**으로 다음 요청부터 이 모델을 고를 수 있습니다.":
        "**Test** installs the model on {instance} (about ${cost} an hour, at most {hours} h) and makes results on the "
        "same prompts as the current models to compare. If it passes, **Approve** makes it selectable from the next "
        "request on.",
    "Hugging Face에서 {listed}개 모델을 확인했고, 필터를 통과한 후보 {candidates}개를 기준 모델과 비교했습니다 "
    "(이미 제안·승인됨 {seen}, 파생·기준 모델 {derived}, 오래됨 {old}, 라이선스 {license}, 추론 코드 없음 {no_inference}).":
        "Models checked on Hugging Face: {listed}. Candidates that passed the filters and were compared with the "
        "current models: {candidates} (already proposed or approved {seen}, derived or current {derived}, old {old}, "
        "license {license}, no inference code {no_inference}).",
    "모델 제안: {label} ({kind})": "Model proposal: {label} ({kind})",
    "조사 완료 — 지금 모델보다 나은 새 후보 없음": "Search done — no new candidate better than the current models",
    "오늘은 제안할 모델이 없습니다.": "No model to propose today.",
    "제안 {n}건. {checked}": "Proposals: {n}. {checked}",
    "시간 제한으로 멈췄습니다 (알림 {n}건).": "Stopped at the time limit (notes: {n}).",
    "{text} (알림 {n}건)": "{text} (notes: {n})",
    "완료했습니다.": "Done.",
    "최대 단계 수에서 멈췄습니다 (알림 {n}건).": "Stopped at the step limit (notes: {n}).",
    "GPU 서버를 시작하지 못했어요. 잠시 뒤 ‘테스트’를 다시 눌러 주세요.": "The GPU server could not be started. Press ‘Test’ again in a moment.",
    "지금은 AWS에 남는 GPU 서버({tried})가 없어 테스트를 시작하지 못했어요. 잠시 뒤 ‘테스트’를 다시 눌러 주세요.":
        "AWS has no free GPU server ({tried}) right now, so the test could not start. Press ‘Test’ again in a moment.",
    "이 제안은 지금 테스트할 수 없어요. 이미 테스트 중이거나 끝난 제안이에요.":
        "This proposal cannot be tested right now. It is already being tested or is finished.",
    "{label}은(는) 이미 승인해서 쓰고 있는 모델이에요.": "{label} is already approved and in use.",
    "다른 모델을 테스트하는 중이에요. 끝난 뒤 다시 눌러 주세요.": "Another model is being tested. Press again when it is done.",
    "테스트를 시작하지 못했습니다: {why}": "The test could not be started: {why}",
    "{days}일 안에 승인하지 않아 GPU 서버를 정리했어요. 쓰려면 다시 테스트해 주세요.":
        "It was not approved within {days} days, so the GPU server was removed. Test it again to use it.",
    "GPU 서버가 켜지지 않았어요. 다시 테스트해 주세요.": "The GPU server did not start. Test it again.",
    "결과는 나왔지만 GPU 서버를 보관하지 못했어요. 다시 테스트해 주세요.":
        "The results are in, but the GPU server could not be kept. Test it again.",
    "결과는 나왔지만 GPU 서버를 승인용으로 보관하지 못했어요: {why}":
        "The results are in, but the GPU server could not be kept for approval: {why}",
    "테스트 실패": "Test failed",
    "시간 초과": "Timed out",
    "결과 없이 인스턴스가 {state}됨": "The instance went {state} with no result",
    "GPU 테스트 통과: {label}": "GPU test passed: {label}",
    "**{label}** (`{repo}`)를 {instance}에서 설치하고 지금 모델과 같은 프롬프트로 결과를 만들었습니다 ({kinds}). 비교해 보고 "
    "**승인**하면 다음 요청부터 이 모델을 고를 수 있습니다. GPU 서버는 정지 상태로 {days}일 동안 승인을 기다립니다 "
    "(디스크 월 약 ${disk}).":
        "**{label}** (`{repo}`) was installed on {instance} and made results on the same prompts as the current models "
        "({kinds}). Compare them and **Approve** to make it selectable from the next request on. The GPU server stays "
        "stopped for {days} days awaiting approval (its disk costs about ${disk} a month).",
    "GPU 테스트 실패: {label}": "GPU test failed: {label}",
    "`{repo}` 테스트가 실패했습니다.": "The test of `{repo}` failed.",
    "인스턴스 사용 약 {hours}시간 (약 ${cost}).": "Instance use: about {hours} h (about ${cost}).",
    "테스트를 통과한 제안만 승인할 수 있어요. 먼저 ‘테스트’를 눌러 주세요.": "Only a proposal that passed its test can be approved. Press ‘Test’ first.",
    "테스트한 GPU 서버가 정리되고 없어요. ‘테스트’를 다시 눌러 주세요.": "The GPU server of the test has been removed. Press ‘Test’ again.",
    "{label}은(는) 이미 승인해서 쓰고 있어요.": "{label} is already approved and in use.",
    "GPU 서버를 연결하지 못했어요. 잠시 뒤 ‘승인’을 다시 눌러 주세요.": "The GPU server could not be connected. Press ‘Approve’ again in a moment.",
    "승인 완료: {label}": "Approved: {label}",
    "**{label}**을(를) `{slug}`로 연결했습니다 ({kinds}). 다음 요청부터 {kind} 모델 목록에서 고를 수 있고, 채팅에서 이름으로 "
    "말해도 됩니다. 기본 모델은 그대로입니다. GPU 서버는 정지해 두었다가 첫 요청에 켜지고(~10분), 20분 쉬면 스스로 정지합니다.":
        "**{label}** is connected as `{slug}` ({kinds}). From the next request on you can pick it in the {kind} model "
        "list or name it in the chat. The default models are unchanged. The GPU server stays stopped, starts on the "
        "first request (~10 min) and stops by itself after 20 min idle.",
    "이미 승인한 모델은 거절할 수 없어요.": "A model that is already approved cannot be declined.",
    "사용자가 거절했습니다": "Declined by the user",
}

# English for the values of the server's own tables (data())
DATA = {
    # viewers.SEED_VIEWERS: the four simulated viewers of the watch window
    "김민지": "Minji Kim", "민지": "MJ", "박준호": "Junho Park", "준호": "JH", "이서연": "Seoyeon Lee", "서연": "SY",
    "최현우": "Hyunwoo Choi", "현우": "HW", "서울": "Seoul", "부산": "Busan", "대전": "Daejeon", "인천": "Incheon",
    "보스 패턴을 외울 때까지 같은 던전을 도는 액션 RPG 고인물":
        "An action RPG veteran who runs the same dungeon until the boss's patterns are memorized",
    "퇴근 후 콘솔로 타임 어택. 드리프트 리플레이를 모으는 레이서":
        "Time attacks on a console after work. A racer who collects drift replays",
    "출퇴근길 모바일로 섬을 꾸미고 도감을 채우는 수집가":
        "A collector who decorates an island and fills the catalogue on mobile during the commute",
    "SF 슈터 랭크전을 매일 돌리는 대학생, 우주 배경이면 일단 클릭":
        "A student who plays ranked sci-fi shooters every day and clicks anything set in space",
    # viewers.CATALOG: the games of their seeded history
    "그림자 군주: 보스 러시": "Shadow Lord: Boss Rush", "드래곤 레이드 온라인": "Dragon Raid Online",
    "심연의 던전": "Dungeon of the Abyss", "네온 드리프트 X": "Neon Drift X", "서킷 레전드": "Circuit Legends",
    "한밤의 추격": "Midnight Chase", "구름섬 수집가": "Cloud Island Collector", "골목 탐험 일기": "Alley Explorer's Diary",
    "보물 정원": "Treasure Garden", "스타 레인저": "Star Ranger", "메카 프론트라인": "Mecha Frontline",
    "은하 침공": "Galaxy Invasion", "좀비 웨이브 30": "Zombie Wave 30",
    # ads.SEED_PERSONAS
    "기본": "Default", "액션 마니아": "Action fan", "ARPG · 보스전": "ARPG · boss fights", "레이서": "Racer",
    "레이싱": "Racing",
    "도시 탐험가": "City explorer", "오픈월드 · 도시": "Open world · city",
    "보스 레이드와 콤보 전투를 즐겨요. 화려한 전투 장면이 있는 트레일러에 반응해요.":
        "Enjoys boss raids and combo fights. Reacts to trailers with spectacular battle scenes.",
    "속도감과 드리프트를 좋아해요. 차량과 추격 장면이 나오는 트레일러를 먼저 봐요.":
        "Likes speed and drifting. Watches trailers with cars and chases first.",
    "넓은 도시를 걸으며 숨은 장소를 찾아요. 풍경과 탐험이 있는 트레일러에 끌려요.":
        "Walks a wide city looking for hidden places. Drawn to trailers with scenery and exploration.",
    # adserver.TAGS: what a viewer likes
    "보스전": "boss fights", "검술": "swordplay", "드래곤": "dragons", "던전": "dungeons", "마법": "magic",
    "자동차": "cars", "드리프트": "drifting", "스피드": "speed", "추격": "chases", "도시": "cities", "수집": "collecting",
    "귀여움": "cute things", "하늘섬": "sky islands", "탐험": "exploration", "우주": "space", "총격": "gunfights",
    "로봇": "robots", "외계인": "aliens", "네온": "neon", "좀비": "zombies", "웨이브": "waves", "점프": "jumping",
    # connections._platform: the platform's services
    "이미지 생성": "Image generation", "영상 생성": "Video generation", "채팅 에이전트": "Chat AI",
    "배경 제거 · Stable Image 생성": "Image touch-up · cutout", "라이브 하이라이트": "Live highlights",
    "3D 렌더": "3D rendering", "라이브 방송": "Live broadcast",
    # providers/rig.py: why a model takes no skeleton (the job's `reason` stays Korean for the web)
    "다리가 보이지 않거나 너무 짧아요": "the legs are not in view or are too short",
    "두 다리의 길이가 다르게 보여요(꼬리나 긴 옷자락이 다리처럼 보일 수 있어요)":
        "the two legs look different in length (a tail or a long hem can look like a leg)",
    "뼈대를 맞출 수 없는 모양이에요": "this shape cannot be fitted with a skeleton",
    # the checks' names (providers/mediagen_image.py)
    "구도 검사 실패": "Composition check failed", "수정 검사 실패": "Edit check failed",
}

# What a check found (providers/cutout.py check, providers/bedrock_image.py EDIT_PROBLEMS): the record stays Korean
# (the web reads it); a chat line on an English page says it through this table. What a vision model wrote after
# "요청 밖 변경:" is its own Korean phrase and stays.
_EDGES = {"위쪽": "top", "아래쪽": "bottom", "왼쪽": "left", "오른쪽": "right"}
_PROBLEMS = (
    (re.compile(r"피사체가 없음"), lambda m: "no subject in the picture"),
    (re.compile(r"피사체 (\d+)개"), lambda m: f"{m[1]} subjects in the picture"),
    (re.compile(r"((?:위쪽|아래쪽|왼쪽|오른쪽)(?:·(?:위쪽|아래쪽|왼쪽|오른쪽))*)이 프레임에 잘림"),
     lambda m: "cut off at the " + ", ".join(_EDGES[e] for e in m[1].split("·"))),
    (re.compile(r"배경을 지우다 빛나는 부분까지 지워짐"), lambda m: "a glowing part was erased with the background"),
    (re.compile(r"투구·가면으로 가려진 머리가 사람 얼굴로 바뀜"), lambda m: "a head covered by a helmet or mask became a human face"),
    (re.compile(r"요청하지 않은 배경 변경"), lambda m: "the background changed without being asked"),
    (re.compile(r"화풍이 바뀜\(또는 서명·글자가 생김\)"), lambda m: "the art style changed (or a signature or text appeared)"),
    (re.compile(r"요청 밖 변경: "), lambda m: "a change that was not asked for: "),
)


def problem(text, lang_: str = None) -> str:
    """A check's problem line in the language."""
    text = str(text or "")
    if (lang_ or _current.get()) != "en":
        return text
    for pattern, said in _PROBLEMS:
        text = pattern.sub(said, text)
    return text
