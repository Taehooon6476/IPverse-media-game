"""One vocabulary for what a user reads from the server, shared with the web: apose "3D용 자세 그림", mesh3d "3D 모델",
rig "움직임 뼈대", render3d "3D 회전 영상" (리깅 and 턴테이블 only as a gloss in brackets), 배경 제거 not 누끼, 쇼츠 not
숏츠. The step names are one table, waits.STEP_LABEL; everything the server says of a 3D chain is built from it or
held to it here, and no line names a tool or a model."""
import inspect
import re

from server import agent, game_assets, jobs, prompts, tools, waits
from server.providers import apose, cutout, deadline, ffmpeg, img3d, mediagen_image, rig

STEPS = {"apose": "3D용 자세 그림", "mesh3d": "3D 모델", "rig": "움직임 뼈대", "render3d": "3D 회전 영상"}
# retired step names, and tool or model names no line may carry
OLD = ("A-포즈", "3D 메시", "리깅", "턴테이블", "3D 렌더", "누끼", "숏츠")
INTERNAL = ("Hunyuan", "Blender", "klein", "Deadline", "PBR", "GLB", "노드", "인스턴스", "가용 영역", "부팅", "모델 로딩",
            "ffmpeg", "Bedrock")


def _descriptions(obj):
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key == "description" and isinstance(value, str):
                yield value
            else:
                yield from _descriptions(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from _descriptions(value)


def _said(function) -> list:
    """The Korean string literals of a function's code, its comments left out."""
    code = "\n".join(line.split("  # ")[0] for line in inspect.getsource(function).splitlines()
                     if not line.strip().startswith("#"))
    return re.findall(r'"([^"\n]*[가-힣][^"\n]*)"', code)


# ── the one table ──────────────────────────────────────────────────────────────

def test_the_steps_of_a_3d_chain_have_the_leads_names_in_one_table():
    assert waits.STEP_LABEL == STEPS
    assert {kind: label for kind, (label, _) in tools.THREE_D_STEPS.items()} == STEPS
    assert list(tools.THREE_D_STEPS) == ["apose", "mesh3d", "rig", "render3d"]  # the order _waiting_3d reads phases in
    assert tools.three_d_order(("apose", "mesh3d", "render3d", "rig")) == \
        "3D용 자세 그림 → 3D 모델 → 3D 회전 영상과 움직임 뼈대(3D 모델이 나오면 함께 시작)"
    assert tools.three_d_order(waits.UNRIGGED) == "3D 모델 → 3D 회전 영상"
    assert tools.three_d_order(("render3d", "rig")) == "3D 회전 영상과 움직임 뼈대(함께 진행)"
    assert tools.three_d_order(("rig",)) == "움직임 뼈대"


def test_a_particle_follows_the_words_last_sound():
    assert waits.josa("3D용 자세 그림", "과", "와") == "3D용 자세 그림과" and waits.josa("움직임 뼈대", "과", "와") == "움직임 뼈대와"
    assert waits.josa("3D 모델", "이", "가") == "3D 모델이" and waits.josa("움직임 뼈대", "이", "가") == "움직임 뼈대가"
    assert waits.josa("3D 회전 영상", "으로", "로") == "3D 회전 영상으로"
    assert waits.josa("3D 모델", "으로", "로") == "3D 모델로" and waits.josa("움직임 뼈대", "으로", "로") == "움직임 뼈대로"  # ㄹ takes 로


# ── what the agent reads ───────────────────────────────────────────────────────

def test_the_wait_copy_and_the_tools_say_the_steps_by_those_names():
    assert waits.RENDER_3D == ("3D 모델 보통 2–8분(GPU 서버가 꺼져 있으면 켜는 데 ~1분, 준비에 ~3–5분 포함), 3D 회전 영상까지 "
                               "전체 보통 6–15분, 3D용 자세 그림과 움직임 뼈대가 붙는 캐릭터·사람형 적은 9–21분")
    copy = [waits.RENDER_3D, tools.BACKGROUND_3D, tools.NOTICE_BACKGROUND_3D, tools.HELD_GAME,
            *(d for spec in tools.TOOL_SPECS for d in _descriptions(spec)), game_assets.SPEC["description"]]
    for text in copy:
        for old in OLD:
            assert old not in text, (old, text[:120])
    said = "\n".join(copy)
    for label in STEPS.values():
        assert label in said, label
    for internal in ("Hunyuan3D", "Blender", "Deadline", "PBR", "MediaTailor"):
        assert internal not in said, internal
    assert "배경을 지운 그림" in said and "쇼츠" in said


def test_the_prompt_teaches_the_cards_words_and_names_the_old_ones_once_to_rule_them_out():
    rule = next(line for line in prompts.SYSTEM.splitlines() if "작업 카드의 이름으로 말한다" in line)
    assert all(label in rule for label in STEPS.values())
    assert "A-포즈, 메시, 리깅, 턴테이블이라고 쓰지 않는다" in rule and "숏츠가 아니라 쇼츠" in rule and "누끼·컷아웃" in rule
    rest = prompts.SYSTEM.replace(rule, "")
    for old in (*OLD, "컷아웃"):
        assert old not in rest, old
    for label in STEPS.values():
        assert label in rest, label
    # the order of the steps is the very line a tool's result gives
    assert tools.three_d_order(("apose", "mesh3d", "render3d", "rig")) in rest
    assert f"그 밖의 IP는 {tools.three_d_order(waits.UNRIGGED)}이다" in rest
    assert not re.search(r"\{(?:apose|mesh3d|rig|render3d|held_button|remake_button|steps_\w+)\}", prompts.SYSTEM)


# ── what a job's card reads ────────────────────────────────────────────────────

def test_a_running_step_says_its_cards_name_and_what_it_does():
    assert '"3D용 자세 그림 그리는 중"' in inspect.getsource(apose.AposeProvider.status)
    assert '"3D 모델 만드는 중 · ' in inspect.getsource(img3d.Img3dProvider.status)
    assert rig.RIG_PHASES["RUNNING"] == "움직임 뼈대 넣는 중"
    assert deadline.PHASES["RUNNING"] == "3D 회전 영상 만드는 중"
    # while it waits on the farm, a rig says the farm's own lines, never the turntable's
    assert {k: v for k, v in rig.RIG_PHASES.items() if k != "RUNNING"} == \
        {k: v for k, v in deadline.PHASES.items() if k != "RUNNING"}
    assert all(line.startswith("렌더 서버") for key, line in deadline.PHASES.items() if key != "RUNNING")


def test_no_line_of_the_3d_chain_names_a_tool_a_model_or_an_old_step():
    lines = [*deadline.PHASES.values(), *rig.RIG_PHASES.values(), *img3d.PHASES.values(), img3d.STARTING,
             img3d.LAUNCHING, img3d.LOADING, img3d.WAITING, img3d.HELD, img3d._booting(img3d.LOAD_SEC),
             mediagen_image.REMOVER_DOWN, cutout.ERASED,
             *_said(apose.AposeProvider.status), *_said(img3d.Img3dProvider.status),
             *_said(deadline.DeadlineProvider.status), *_said(rig.RigProvider.status),
             *_said(jobs._noted), *_said(jobs._bind_turntable)]
    assert len(lines) > 30
    for line in lines:
        for word in (*OLD, *INTERNAL):
            assert word not in line, (word, line)
    # the place in the GPU queue keeps the form the card lifts off the line (web/src/types.ts QUEUE_WAIT)
    assert re.search(r'f"\{line\} · 시작까지 약 \{_min\(wait\)\}분"', inspect.getsource(img3d.Img3dProvider._place))


def test_a_trailer_that_fails_names_the_shorts_as_the_screen_does():
    assert '"쇼츠" if name == "shorts" else "트레일러"' in inspect.getsource(ffmpeg._render_cut)
    assert "ffmpeg 종료 코드" not in inspect.getsource(ffmpeg._render_cut)


# ── what a reply says ──────────────────────────────────────────────────────────

def test_a_reply_says_the_cards_words_for_the_ones_its_history_still_holds():
    said = agent.humanize_tools
    # stored replies that still hold the retired names
    assert said("캐릭터라서 A-포즈, 3D 메시, 턴테이블 렌더와 리깅까지 보통 9~21분 걸립니다.") == \
        "캐릭터라서 3D용 자세 그림, 3D 모델, 3D 회전 영상과 움직임 뼈대까지 보통 9~21분 걸립니다."
    assert said("지금 턴테이블 렌더와 리깅이 동시에 진행 중이고, 리깅까지 끝나야 주인공으로 쓸 수 있습니다.") == \
        "지금 3D 회전 영상과 움직임 뼈대가 동시에 진행 중이고, 움직임 뼈대까지 끝나야 주인공으로 쓸 수 있습니다."
    assert said("3D 메시 → 3D 렌더(턴테이블)와 리깅 순서로 진행합니다.") == "3D 모델 → 3D 회전 영상과 움직임 뼈대 순서로 진행합니다."
    assert said("턴테이블 영상은 3D 탭에 있어요.") == "3D 회전 영상은 3D 탭에 있어요."
    assert said("A-포즈로 다시 그리고 있어요.") == "3D용 자세 그림으로 다시 그리고 있어요."
    assert said("누끼를 다시 만들었고 숏츠도 함께 잘라요.") == "배경 제거를 다시 만들었고 쇼츠도 함께 잘라요."
    # 리깅 as a verb keeps its ending
    assert said("리깅된 모델에 판이 붙었어요. 다시 리깅하지 않아도 돼요.") == "뼈대 작업된 모델에 판이 붙었어요. 다시 뼈대 작업하지 않아도 돼요."


def test_a_gloss_in_brackets_and_other_words_are_left_alone():
    said = agent.humanize_tools
    for kept in ("움직임 뼈대(리깅)를 넣는 중이에요.", "3D 회전 영상(턴테이블)이 끝났어요.", "3D 렌더링 품질이 좋아요.",
                 "메시지를 보냈어요.", "3D 메시지 카드를 만들었어요."):
        assert said(kept) == kept, kept
    assert said("움직임 뼈대(움직임 뼈대)가 끝났어요.") == "움직임 뼈대가 끝났어요."  # said once


def test_the_work_log_and_the_reply_name_a_tool_by_the_buttons_word():
    labels = tools._LABELS
    assert (labels["render_3d"], labels["make_game"], labels["publish_game"]) == ("3D로 만들기", "게임 만들기", "게시하기")
    assert (labels["make_ip_variant"], labels["reroll_ip_image"], labels["get_game_spec"]) == ("수정하기", "다시 뽑기", "게임 설계 읽기")
    for label in labels.values():
        for stale in ("등록", "생성", "배포", "에셋", "설정", "렌더"):
            assert stale not in label, label
    assert tools.summarize("render_3d", {}, {"jobId": "job_1"}) == "3D로 만들기: job_1"
    assert tools.summarize("publish_game", {}, {"publishedUrl": "u"}) == "게시하기"
    assert tools.summarize("create_ip_asset", {"kind": "prop", "name": "등불"}, {}) == "소품 만들기: 등불"
    assert tools.summarize("make_game", {}, {"error": "x", "message": "짧은 이유"}) == "게임 만들기 실패: 짧은 이유"
    # one table: what a reply calls a tool is what 작업 기록 calls it (an IP made in chat is of no one kind)
    assert agent.TOOL_LABELS == {**labels, "create_ip_asset": "IP 만들기"}
    assert set(labels) == set(tools.TOOLS)
