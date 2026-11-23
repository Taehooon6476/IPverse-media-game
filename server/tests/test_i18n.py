"""The server's language core (server/i18n.py): the request's language, the session's memory of it, tr() and the
coverage of its English dictionary: every Korean sentence passed to tr() anywhere in server/ has an English one."""
import ast
import json
import pathlib
import re
import string

import pytest

from server import i18n
from server.i18n import tr

SERVER = pathlib.Path(__file__).resolve().parents[1]
HANGUL = re.compile(r"[가-힣]")


@pytest.fixture(autouse=True)
def korean_after():
    yield
    i18n.use("ko")


# ── the request's language ─────────────────────────────────────────────────────

@pytest.mark.parametrize("headers, lang", [
    ({}, "ko"), (None, "ko"), ({"x-lang": "en"}, "en"), ({"X-Lang": "en"}, "en"), ({"x-lang": "EN "}, "en"),
    ({"x-lang": "ko"}, "ko"), ({"x-lang": "ja"}, "ko"), ({"x-lang": ""}, "ko"), ({"x-lang": "en-US"}, "ko"),
])
def test_the_language_is_the_header_and_korean_unless_it_says_en(headers, lang):
    assert i18n.from_event({"headers": headers}) == lang


def test_tr_is_korean_by_default_and_fills_places_in_both():
    key = "메시지가 너무 길어요. {limit}자 안으로 줄여 다시 보내 주세요."
    assert tr(key, limit="4,000") == "메시지가 너무 길어요. 4,000자 안으로 줄여 다시 보내 주세요."
    i18n.use("en")
    assert tr(key, limit="4,000") == "That message is too long. Shorten it to 4,000 characters and send it again."
    assert tr(key, "ko", limit="4,000").startswith("메시지가")
    assert tr("사전에 없는 문장") == "사전에 없는 문장"  # no English: the Korean, as on the web
    i18n.use("fr")
    assert i18n.lang() == "ko"


def test_labels_are_the_glossary():
    for ko, en in (("게임 만들기", "Make game"), ("게임에 반영", "Apply to game"), ("3D로 만들기", "Make 3D"),
                   ("작업 현황", "Jobs"), ("작업 기록", "Work log"), ("다시 뽑기", "Redraw"), ("움직임 뼈대", "Rig"),
                   ("3D 회전 영상", "Turntable video"), ("라이브 켜기", "Go live"), ("시청 창", "Watch window"),
                   ("플레이어블 서버", "Playable server"), ("받은 편지함", "Inbox"), ("게시하기", "Publish")):
        assert i18n.label(ko, "en") == en and i18n.label(ko, "ko") == ko
    assert not [k for k, v in i18n.LABELS.items() if HANGUL.search(v)]


# ── the web's dictionaries: one name for one thing on both sides ───────────────
#
# The web's English is three plain tables keyed by the Korean sentence (web/src/i18n/en-*.ts: `'한국어': 'English'`),
# read here from the source: a Korean key that both sides have says the same English on both, or stands in one of the
# lists below with its reason.

WEB_I18N = SERVER.parent / "web" / "src" / "i18n"


def _ts_tokens(src: str):
    """The string literals of a TypeScript source and the punctuation between them; comments are dropped."""
    i = 0
    while i < len(src):
        c = src[i]
        if src.startswith("//", i):
            i = src.find("\n", i) if "\n" in src[i:] else len(src)
        elif src.startswith("/*", i):
            i = src.index("*/", i) + 2
        elif c in "'\"`":
            j, out = i + 1, []
            while src[j] != c:
                if src[j] == "\\":
                    j += 1
                    out.append({"n": "\n", "t": "\t"}.get(src[j], src[j]))
                else:
                    out.append(src[j])
                j += 1
            yield "str", "".join(out)
            i = j + 1
        else:
            if c in ":,+}":
                yield c, c
            i += 1


def web_dictionary(path) -> dict:
    """One table of web/src/i18n/en-*.ts → {Korean: English} (a literal may be several joined by +)."""
    src = path.read_text()
    body = src[src.index("= {", src.index("export const EN_")) + 3:]
    out, key, value, side = {}, [], [], "key"
    for kind, text in _ts_tokens(body):
        if kind == "str":
            (key if side == "key" else value).append(text)
        elif kind == ":" and side == "key":
            side = "value"
        elif kind in ",}":
            if key and value:
                out["".join(key)] = "".join(value)
            key, value, side = [], [], "key"
            if kind == "}":
                break
    return out


def web_english() -> dict:
    """→ {Korean: {package: English}} over the web's dictionaries."""
    if not WEB_I18N.is_dir():
        pytest.skip("no web sources beside the server")
    out = {}
    for path in sorted(WEB_I18N.glob("en-*.ts")):
        for ko, en in web_dictionary(path).items():
            out.setdefault(ko, {})[path.stem[3:]] = en
    return out


# The same Korean for two different controls: both are left.
OTHER_CONTROL = {
    "IP 만들기": "the work log's tool line (Make IP) and the genre skills' button that makes several (Make IPs)",
    "가상 시청자": "the console's section, which the agent names (Simulated viewers), and a select's field label",
}
# A word the server says inside a sentence, lower-case, and the web shows as a label.
MID_SENTENCE = {"영상", "이미지", "준비 중", "우주", "보스전", "수집", "점프"}
# Differences the web is still to change to the server's word: (Korean, web package). An entry that no longer differs
# fails the test.
WEB_CHANGES: set = set()


def _drift(table: dict, skip=()) -> dict:
    web = web_english()
    return {(ko, package): (en, theirs) for ko, en in table.items() if ko not in skip
            for package, theirs in web.get(ko, {}).items() if theirs != en}


def test_the_web_dictionaries_are_read_from_their_source():
    web = web_english()
    assert len(web) > 1000 and {p for said in web.values() for p in said} == {"shell", "panes", "live"}
    assert "Make game" in web["게임 만들기"].values() and "Make 3D" in web["3D로 만들기"].values()
    assert "{n} s" in web["{n}초"].values()  # a place is kept as written
    assert all(HANGUL.search(ko) or "{" in ko or ko.isascii() for ko in web)
    said = [en for packages in web.values() for en in packages.values()]
    assert all(said) and not [en for en in said if HANGUL.search(en)]
    assert [en for en in said if "'" in en]  # an escaped quote is read as the quote


def test_a_name_the_server_and_the_web_both_have_is_the_same_english():
    """A button, tab, step, genre or tool by one English name on both sides (i18n.LABELS against the web)."""
    drift = _drift(i18n.LABELS, OTHER_CONTROL)
    left = {k: v for k, v in drift.items() if k not in WEB_CHANGES}
    assert not left, "the server and the web name these differently (server, web):\n" + "\n".join(
        f"{ko} [{package}]: {en!r} / {theirs!r}" for (ko, package), (en, theirs) in sorted(left.items()))
    assert set(OTHER_CONTROL) <= set(i18n.LABELS)


def test_a_sentence_the_server_and_the_web_both_have_is_the_same_english():
    """... and the sentences and table values both sides say (i18n.EN, i18n.DATA)."""
    drift = {**_drift(i18n.EN, MID_SENTENCE), **_drift(i18n.DATA, MID_SENTENCE)}
    left = {k: v for k, v in drift.items() if k not in WEB_CHANGES}
    assert not left, "the server and the web say these differently (server, web):\n" + "\n".join(
        f"{ko} [{package}]: {en!r} / {theirs!r}" for (ko, package), (en, theirs) in sorted(left.items()))


def test_the_lists_of_known_differences_hold_nothing_that_is_the_same_by_now():
    drift = {**_drift(i18n.LABELS), **_drift(i18n.EN), **_drift(i18n.DATA)}
    stale = sorted(WEB_CHANGES - set(drift))
    assert not stale, f"the web says these as the server does now: take them out of WEB_CHANGES: {stale}"
    differs = {ko for ko, _ in drift}
    assert set(OTHER_CONTROL) <= differs and MID_SENTENCE <= differs


# ── coverage: no Korean sentence without English ───────────────────────────────

def _sources():
    return [p for p in sorted(SERVER.rglob("*.py")) if "tests" not in p.parts]


def _constants(tree) -> dict:
    """A module's own constants: NAME = "…" (adjacent literals are one) → [the sentence]; NAME = {key: "…"} → the
    table's sentences (tr(NAME[key]))."""
    out = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        value = node.value
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            found = [value.value]
        elif isinstance(value, ast.Dict) and value.values and all(
                isinstance(v, ast.Constant) and isinstance(v.value, str) for v in value.values):
            found = [v.value for v in value.values]
        else:
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                out[target.id] = found
    return out


def tr_keys():
    """→ ({sentence: [where]}, [calls whose first argument is neither a literal nor a module constant])."""
    trees = {p: ast.parse(p.read_text()) for p in _sources()}
    by_module = {p.stem: _constants(tree) for p, tree in trees.items()}
    keys, unreadable = {}, []
    for path, tree in trees.items():
        own = by_module[path.stem]
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not node.args:
                continue
            f = node.func
            if not ((isinstance(f, ast.Name) and f.id == "tr") or (isinstance(f, ast.Attribute) and f.attr == "tr"
                                                                   and isinstance(f.value, ast.Name) and f.value.id == "i18n")):
                continue
            arg, where = node.args[0], f"{path.relative_to(SERVER.parent)}:{node.lineno}"
            if isinstance(arg, ast.Subscript):  # a table of sentences: tr(TABLE[key])
                arg = arg.value
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                found = [arg.value]
            elif isinstance(arg, ast.Name) and arg.id in own:
                found = own[arg.id]
            elif (isinstance(arg, ast.Attribute) and isinstance(arg.value, ast.Name)
                  and arg.attr in by_module.get(arg.value.id, {})):
                found = by_module[arg.value.id][arg.attr]
            else:
                unreadable.append(where)
                continue
            for key in found:
                keys.setdefault(key, []).append(where)
    return keys, unreadable


# A refusal is written where it is raised, as a literal or an f-string (test_round20_errors.py sweeps those sentences),
# and its error class says it in the request's language (i18n.said): the sentence itself, or the EN sentence whose
# {places} the f-string fills.
RAISED = {"HttpError", "LiveError", "AgentError", "ConnError", "StreamError", "AdsError", "AdError"}
# name → where its sentence is: an error class's third argument; app._client_error's second (it raises that sentence)
# ... and i18n.said's own first, where a line is said as written
SAYS = {**{name: 2 for name in RAISED}, "_client_error": 1, "said": 0}


def _shapes(node) -> list:
    """The sentences a raised message can be, each as a pattern of its text (what is formatted in: anything)."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [re.escape(node.value)]
    if isinstance(node, ast.JoinedStr):
        return ["".join(re.escape(v.value) if isinstance(v, ast.Constant) else ".+?" for v in node.values)]
    if isinstance(node, ast.IfExp):
        return _shapes(node.body) + _shapes(node.orelse)
    return []  # a name or a call: tr() where it is made


def raised_keys():
    """→ ({EN sentence a raise site can say: [where]}, {where: a raised Korean sentence with no English})."""
    keys, missing = {}, {}
    for path in _sources():
        for node in ast.walk(ast.parse(path.read_text())):
            called = getattr(node, "func", None)
            at = SAYS.get(getattr(called, "id", getattr(called, "attr", ""))) if isinstance(node, ast.Call) else None
            if at is None or len(node.args) <= at:
                continue
            where = f"{path.relative_to(SERVER.parent)}:{node.lineno}"
            for shape in _shapes(node.args[at]):
                if not HANGUL.search(shape):
                    continue
                said = [k for k in i18n.EN if re.fullmatch(shape, k, re.S)]
                for key in said:
                    keys.setdefault(key, []).append(where)
                if not said:
                    missing[where] = shape
    return keys, missing


def _places(text: str) -> set:
    return {name for _, name, _, _ in string.Formatter().parse(text) if name}


def test_every_korean_sentence_passed_to_tr_has_english():
    keys, unreadable = tr_keys()
    assert not unreadable, "tr() takes a string literal or a module constant first:\n" + "\n".join(unreadable)
    assert len(keys) > 150  # the scan sees the sources
    missing = {k: w[0] for k, w in keys.items() if HANGUL.search(k) and k not in i18n.EN}
    assert not missing, "no English for:\n" + "\n".join(f"{w}: {json.dumps(k, ensure_ascii=False)}"
                                                         for k, w in sorted(missing.items(), key=lambda kv: kv[1]))


def test_every_refusal_raised_as_written_has_english():
    keys, missing = raised_keys()
    assert len(keys) > 100  # the sweep sees the raise sites
    assert not missing, "no English for:\n" + "\n".join(f"{w}: {s}" for w, s in sorted(missing.items()))


@pytest.mark.parametrize("raised, english", [
    ("세션을 찾지 못했어요. 목록에서 다시 골라 주세요.", "That session was not found. Pick it again from the list."),
    ("진행 중인 작업 3건이 있어 지울 수 없어요. 작업 현황에서 중지하거나 끝난 뒤 다시 시도해 주세요.",
     "Jobs still in progress: 3. Stop them in Jobs, or try again when they finish."),
    ("메시지가 너무 길어요. 4,000자 안으로 줄여 다시 보내 주세요.",
     "That message is too long. Shorten it to 4,000 characters and send it again."),
    ("플레이어블 서버를 내리지 못했어요. 잠시 뒤 다시 눌러 주세요.", "The playable server could not be shut down. Press again in a moment."),
    ("이 하이라이트를 방송에 내보낼 준비를 하고 있어요. 1–2분 뒤에 보내 주세요.",
     "This highlight is being prepared for the broadcast. Send it in 1–2 min."),
    ("체험 길이는 30–180초 사이에서 골라 주세요.", "Pick a trial length of 30–180 s."),
    ("Qwen-Image 2.1은(는) 이미 승인해서 쓰고 있는 모델이에요.", "Qwen-Image 2.1 is already approved and in use."),
    ("mcp.example.com 주소를 찾지 못했어요. 주소를 다시 확인해 주세요.", "The address mcp.example.com was not found. Check the address again."),
])
def test_a_raised_sentence_is_said_in_english_with_its_values(raised, english):
    assert i18n.said(raised) == raised  # Korean by default
    assert i18n.said(raised, "en") == english
    assert i18n.said(english, "en") == english  # a sentence already in English is left as it is
    assert i18n.said("사전에 없는 문장이에요.", "en") == "사전에 없는 문장이에요."


def test_said_fills_a_template_only_with_places_it_can_say():
    """said() fills a template's place only with what it can say (a sentence of EN, a label, a table's value, a
    check's problem, a wait); where Korean is left in one, the template is not this sentence's, so
    "구도 검사 실패: 위쪽이 프레임에 잘림" never comes back half translated."""
    half = "구도 검사 실패: 위쪽이 프레임에 잘림"
    assert i18n.said(half, "en") == half
    assert i18n.said("알 수 없는 검사 실패: 이유 없음", "en") == "알 수 없는 검사 실패: 이유 없음"
    # a place that is itself one of the server's sentences, labels, values or problems is said
    assert i18n.said("MCP 서버에 연결하지 못했어요. 주소와 인증 값을 확인한 뒤 다시 해 주세요.", "en") == (
        "The MCP server could not be connected. Check the address and the auth value and try again.")
    assert i18n.said("게임 만들기 실패: 주인공의 3D가 아직 끝나지 않았어요", "en") == "Make game failed: The hero's 3D is not finished yet"
    assert i18n.said("다시 뽑기 실패: 피사체 2개", "en") == "Redraw failed: 2 subjects in the picture"
    assert i18n.said("이 하이라이트를 방송에 내보낼 준비를 하고 있어요. 1–2분 뒤에 보내 주세요.", "en").endswith("Send it in 1–2 min.")
    assert i18n.said("GPU 테스트 실패: Qwen-Image 2.1", "en") == "GPU test failed: Qwen-Image 2.1"


def test_what_a_turn_writes_of_an_mcp_tool_keeps_the_users_own_name_for_it():
    """The work log's line of the user's MCP tool is a sentence with places (tr), not one read back from its text:
    the connection's name is the user's and may be Korean."""
    assert tr("MCP 도구: {server} · {tool}", "en", server="내 서버", tool="search") == "MCP tool: 내 서버 · search"
    assert tr("{label} 실패: {why}", "en", label="MCP tool: 내 서버 · search", why="시간 초과") == (
        "MCP tool: 내 서버 · search failed: 시간 초과")
    source = (SERVER / "agent.py").read_text()
    assert 'i18n.said(f"' not in source and 'tr("MCP 도구: {server} · {tool}"' in source


def test_an_error_says_its_sentence_in_the_requests_language():
    from server import agents, app, connections, live, playable, streams
    for cls in (app.HttpError, live.LiveError, agents.AgentError, connections.ConnError, playable.AdError,
                streams.StreamError):
        assert cls(400, "bad_request", "없는 시청자예요").message == "없는 시청자예요"
    i18n.use("en")
    for cls in (app.HttpError, live.LiveError, agents.AgentError, connections.ConnError, playable.AdError,
                streams.StreamError):
        assert cls(400, "bad_request", "없는 시청자예요").message == "There is no such viewer"


def test_the_english_has_no_korean_and_only_the_places_of_its_sentence():
    assert not {k: v for k, v in i18n.EN.items() if HANGUL.search(v)}
    # (a name with its Korean particle is a place of its own, {name_ul}: the English takes the bare {name})
    def allowed(k):
        return _places(k) | {p.rsplit("_", 1)[0] for p in _places(k) if "_" in p}
    assert not {k: v for k, v in i18n.EN.items() if _places(v) - allowed(k)}
    assert not [v for v in i18n.EN.values() if v.endswith("!")]  # product English: no exclamation marks


def test_a_count_that_can_be_one_is_not_said_as_a_plural():
    """The English says the thing and then its count ("Jobs still in progress: 1"), never "1 jobs", "1 times" or
    "(1 wins)"."""
    for ko, places in (("진행 중인 작업 {n}건이 있어 지울 수 없어요. 작업 현황에서 중지하거나 끝난 뒤 다시 시도해 주세요.", {"n": 1}),
                       ("{label} 광고 클릭 {n}회", {"label": "Racing", "n": 1}), ("{label} 게임 구매 {n}회", {"label": "Racing", "n": 1}),
                       ("{label} 게임 찜 {n}회", {"label": "Racing", "n": 1}), (" ({wins}승)", {"wins": 1}),
                       ("{label} 플레이어블 체험 {n}회", {"label": "Racing", "n": 1}),
                       ("{label} 광고 스킵 {n}회 (감점)", {"label": "Racing", "n": 1}), ("제안 {n}건. {checked}", {"n": 1, "checked": ""}),
                       ("시간 제한으로 멈췄습니다 (알림 {n}건).", {"n": 1}), ("{text} (알림 {n}건)", {"text": "Done.", "n": 1}),
                       ("최대 단계 수에서 멈췄습니다 (알림 {n}건).", {"n": 1})):
        said = tr(ko, "en", **places)
        assert not re.search(r"\b1 \w+s\b", said), said
    assert tr("{label} 광고 클릭 {n}회", "en", label="Racing", n=1) == "Racing ad clicks: 1"
    assert tr("제안 {n}건. {checked}", "en", n=1, checked="").strip() == "Proposals: 1."
    # an HTTP status and a count inside a sentence
    assert tr("인증이 필요하거나 거부됐어요 (HTTP {code}). 인증 헤더와 값을 확인해 주세요.", "en", code=401) == (
        "Authentication is required or was refused (HTTP 401). Check the auth header and its value.")
    assert tr("내부 주소로는 연결할 수 없어요. 밖에서 열리는 주소를 넣어 주세요.", "en") == (
        "Internal addresses cannot be used. Enter a publicly reachable address.")
    assert tr("지금은 미리 연결해 둘 수 없는 광고예요. 누르면 바로 시작해요", "en") == (
        "This ad cannot be pre-connected right now. It starts when you press it")
    assert tr("{label} 광고 스킵 {n}회 (감점)", "en", label="Racing", n=2) == "Racing ad skips: 2 (penalty)"


def test_no_dictionary_entry_is_left_without_a_caller():
    keys, _ = tr_keys()
    assert not sorted(set(i18n.EN) - set(keys) - set(raised_keys()[0]))
