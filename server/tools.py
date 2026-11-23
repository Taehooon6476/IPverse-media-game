"""The agent's tools: Converse toolSpecs + implementations.

Mistakes the caller can fix come back as {"error", "message"} (the agent retries); anything else raises.
"""
from __future__ import annotations
import json
import mimetypes
import math
import os
import random
import re

from server import connections, game_design, gamespec, i18n, jobs, store
from server.i18n import tr
from server import video_edit, waits
from server import game_assets
from server.providers import mediagen_video
from server.authored_contract import AUTHORED_PROPERTIES, hero_attack
from server.providers import cutout, generate_image, mediagen_image, remove_background, s3_key_for
from server.providers import rig as rig_tool  # render_3d has a job of its own named rig
from server.providers.apose import pose_key
from server.providers.bedrock_image import grip_side
from server.providers.img3d import Img3dProvider, glb_key

RUNTIME_PREFIX = os.environ.get("RUNTIME_PREFIX", "runtime/v1/")
RUNTIME_FILES = ("index.html", "runtime.js", "shooter.js", "rpg.js", "gamespec.js")
LUTS = ("teal-orange", "warm", "noir", "none")
NEGATIVE = "text, watermark, blurry, multiple subjects, cropped, multiple characters, duplicate, character sheet"
DEFAULT_STYLE = "Stylized game concept art"
DEFAULT_ACCENT = "#5de6cf"
FIXED_SECONDS = {"minimax-h3": 5, "kandinsky-6-0-video-pro": 5}
ANIMATE_SECONDS = 4
STABILITY = "stability-ultra"  # Stable Image Ultra on Bedrock; the other image models are the image MCP's (list_models)
IP_KINDS = ("character", "prop", "weapon", "enemy")
WEAPON_TYPES = ("melee", "gun")
ACTION_SHOT_SECONDS = 5
RENDER_MODELS = ("hunyuan3d", "relief")  # hunyuan3d: GPU mesh + Blender turntable of it; relief: Blender only
_STEP = waits.STEP_LABEL  # what the cards call the steps of a 3D chain: every line below names them from this table
# The two buttons a user is told about: a request that waits for 3D has made no game yet, so its button makes one;
# a game that exists takes the new 3D in. The web's toasts say the same two (web/src/api.ts), and a reply that
# names the first one promises a hold (agent._keep_hold).
HELD_BUTTON = "게임 만들기"
REMAKE_BUTTON = "게임에 반영"
# The panel's time is its card's: its one job is the render (waits.RELIEF)
BACKGROUND_3D = ("배경(장면 전체)은 물체 하나를 3D로 만드는 단계에 넣지 않았습니다: 장면은 조각으로만 나옵니다. "
                 f"대신 장면 그림 전체에 두께만 준 판과 그 {waits.josa(_STEP['render3d'], '을', '를')} 만듭니다({waits.RELIEF}). "
                 "걸어 다닐 수 있는 3D 환경·지형은 아니니 사용자에게 그렇게 알리고, 게임 배경에는 world.background mode "
                 "image(원본 그림)를 쓰세요.")
# What a card shows the user beside the agent's message: one sentence of at most 60 characters
BACKGROUND_3D_NOTICE = "배경은 걸어 다닐 수 있는 3D 대신 두께만 준 그림 판과 {step_ro} 만들어요({wait})."
NOTICE_BACKGROUND_3D = BACKGROUND_3D_NOTICE.format(step_ro=waits.josa(_STEP["render3d"], "으로", "로"), wait=waits.RELIEF)


def _notice_background_3d() -> str:
    """NOTICE_BACKGROUND_3D in the request's language (a card's toast)."""
    return tr(BACKGROUND_3D_NOTICE, step=i18n.label(_STEP["render3d"]), step_ro=waits.josa(_STEP["render3d"], "으로", "로"),
              wait=i18n.span(waits.RELIEF))
NOTICE_CHECK_FAILED_3D = "구도 검사를 통과하지 못한 그림이라 3D도 그 모양대로 나오니 다시 뽑아 보세요."
# ... of a picture the edit check failed (a restored version): nothing is cut, the edit changed more than asked
NOTICE_EDIT_FAILED_3D = "수정 검사를 통과하지 못한 그림이라 3D도 그 모습대로 나오니 다시 뽑아 보세요."
NOTICE_CHECK_FAILED_FIRST = "첫 그림이 구도 검사를 통과하지 못했으니 다시 뽑아 보세요."
# ... of a shot whose video model is stopped, gone or cannot make that shot (a shot's 다시 뽑기 sends the model the
# first one was made with): the agent's copy lists the model ids
NOTICE_SHOT_MODEL = "이 영상 모델은 지금 쓸 수 없으니 잠시 뒤 다시 누르거나 채팅에서 다른 모델로 요청해 주세요."
IMAGE_SEC, SWAP_SEC = 30, 120  # rough wait for queued GPU images: ~30 s each on the box plus one ~2 min model swap

# ── Converse toolSpecs ─────────────────────────────────────────────────────────

_STR = {"type": "string"}
_HEX = {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"}


# unreal is a make_game choice, not a GameSpec engine: its spec.json is the three.js build (preview/fallback)
MAKE_GAME_ENGINES = (*gamespec.ENGINES, "unreal")


def _enum(values):
    return {"type": "string", "enum": list(values)}


def _int(lo, hi):
    return {"type": "integer", "minimum": lo, "maximum": hi}


def _obj(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required)}


def _spec(name, description, properties, required):
    return {"name": name, "description": description, "inputSchema": {"json": _obj(properties, required)}}


_GAMESPEC = _obj({
    "version": {"type": "integer", "enum": [1, 2]},
    "engine": {**_enum(gamespec.ENGINES), "description": "생략할 수 있다: 엔진은 make_game의 engine 인자로 고른다 "
                                                         "(version 2는 three로 채워진다)"},
    "title": _STR,
    "genre": _enum(gamespec.GENRES),
    "palette": _obj({"bg": _HEX, "accent": _HEX, "text": _HEX}, ["bg", "accent", "text"]),
    "player": _obj({"ipId": _STR, "name": _STR, "speed": _int(1, 3),
                    "weaponIpId": {"type": "string", "description": "선택. 주인공이 손에 드는 무기 IP(kind weapon)"}},
                   ["ipId", "name", "speed"]),
    "props": {"type": "array", "items": _obj(
        {"ipId": _STR, "name": _STR, "effect": _enum(gamespec.EFFECTS)}, ["ipId", "name", "effect"])},
    "enemies": {"type": "array", "maxItems": 5, "items": _obj(
        {"name": _STR, "color": _HEX, "shape": _enum(gamespec.SHAPES), "speed": _int(1, 3), "hp": _int(1, 3),
         "ipId": {"type": "string", "description": "선택. 이 적으로 나올 적·캐릭터 IP. 없으면 절차적 드론·몬스터"},
         "weaponIpId": {"type": "string", "description": "선택. 이 적이 드는 무기 IP"}},
        ["name", "color", "shape", "speed", "hp"])},
    "objective": _obj({"type": _enum(("kills", "survive", "boss", "collect", "reach", "talk", "interact", "drive")), "target": _int(1, 200),
                       "label": {"type": "string", "maxLength": 60, "description": "선택. 화면 목표 줄에 보일 미션 문장"}},
                      ["type", "target"]),
    "environment": _obj({"theme": _enum(gamespec.THEMES), "sky": _enum(gamespec.SKIES), "layout": _enum(gamespec.LAYOUTS),
                         "size": _int(18, 45), "obstacles": _int(0, 30)}),
    "rules": _obj({"timeLimitSec": _int(0, 900), "enemyRate": {"type": "number", "minimum": 0.25, "maximum": 3},
                   "playerHp": _int(50, 500)}),
    "difficulty": _enum(gamespec.DIFFICULTIES),
    "dialogue": {"type": "array", "maxItems": 12, "items": _obj(
        {"speaker": _STR, "text": {"type": "string", "maxLength": 140}}, ["speaker", "text"])},
    "quest": _obj({"giverName": _STR, "itemName": _STR, "itemPropIndex": {"type": "integer", "minimum": 0},
                   "completeText": _STR}),
    "map": _obj({"width": _int(12, 30), "height": _int(9, 20), "seed": {"type": "integer"}}),
}, ["version", "title", "genre", "palette", "player", "objective", "difficulty"])
_GAMESPEC["properties"].update(AUTHORED_PROPERTIES)

TOOL_SPECS = [
    _spec("set_concept", "세션 컨셉(제목, 한 줄 소개, 화풍, 팔레트 3색)과 장르를 정한다. 컨셉이 없는 세션에서는 가장 먼저 호출한다.", {
        "title": _STR,
        "logline": _STR,
        "style": {"type": "string", "description": "이미지 프롬프트 맨 앞에 붙는 짧은 영어 화풍 (예: stylized 3D animation)"},
        "palette": {"type": "array", "items": _HEX, "minItems": 3, "maxItems": 3,
                    "description": "#rrggbb 3개. 첫 색이 강조색(UI, 3D 측면)"},
        "genre": _enum(gamespec.GENRES),
    }, ["title", "logline", "style", "palette", "genre"]),
    _spec("create_ip_asset", "캐릭터·소품·무기·적 IP를 만든다. IP는 바로 등록되고 krea·klein9 이미지는 GPU 작업(jobId)으로 그려져 "
          f"바로 돌아온다(한 장에 {waits.IMAGE}, 여러 장이면 차례로). stability-ultra는 몇 초 안에 "
          "바로 만든다. 일반 물체는 배경 제거, usage background 소품은 전체 환경을 보존한다.", {
        "kind": {**_enum(IP_KINDS), "description": "character=캐릭터, prop=소품·아이템, weapon=무기·도구(가로로 눕혀 그리고 "
                                                   "3D·게임에서는 손잡이가 아래로 세워짐), enemy=적(humanoid로 사람형/비사람형 구분)"},
        "humanoid": {"type": "boolean", "description": "enemy만. true(기본)=사람형 적(팔을 벌리고 선 자세로 그려 "
                                                       "움직임 뼈대를 넣는다), false=드론·짐승 같은 비사람형(정해진 동작으로 "
                                                       "움직인다). 다른 kind에서는 무시한다"},
        "weapon_type": {**_enum(WEAPON_TYPES), "description": "weapon만. melee=칼·도끼 등 근접(기본), gun=총·블래스터. "
                                                              "다른 kind에서는 무시한다"},
        "usage": {**_enum(("object", "background")), "description": "기본 object. 배경·장소 전체를 만들 때 prop에만 background를 지정: 배경 제거하지 않음"},
        "name": _STR,
        "description": {"type": "string", "description": "이미지 모델 프롬프트로 쓰이는 외형 묘사 (영어, 구체적으로). "
                                                         "무기에는 방향·구도·카메라(vertical, handle at the bottom, "
                                                         "cinematic, close-up 등)를 쓰지 않는다. "
                                                         "가늘고 긴 소품은 끝에 lying horizontally across the frame"},
        "role": {"type": "string", "description": "예: 주인공, 라이벌, 핵심 아이템"},
        "image_model": {"type": "string", "description": "이미지 MCP(list_models)의 모델 id 또는 stability-ultra. krea=Krea 2 "
                                                         "Turbo(기본), klein9=FLUX.2 klein 9B(레퍼런스 이미지), stability-ultra="
                                                         "Stable Image Ultra(Bedrock), 그 밖에 이미지 MCP에 추가된 모델 id"},
        "reference_ip_id": {"type": "string", "description": "기존 IP에서 파생한 새 IP(쌍둥이, 다른 버전 캐릭터 등)일 때 그 IP의 ipId. "
                                                             "klein9가 그 이미지를 레퍼런스로 쓴다"},
    }, ["kind", "name", "description"]),
    _spec("make_ip_variant", "기존 IP의 새 버전(캐릭터 외형 또는 환경 배경 변경)을 FLUX.2 klein 9B 작업으로 등록하고 바로 돌아온다. "
          "원본 IP를 레퍼런스로 유지하고, 작업이 끝나면 IP의 version이 1 오른다(IP 이미지가 아직 그려지는 중이면 그 뒤에 시작). "
          "일반 IP는 배경을 지운 그림도 만들고 배경 usage는 전체 장소를 보존한다. 지금 그림은 그대로 두고 한 부분만 바꿀 때 쓴다: 그림을 "
          "새로 다시 그려 달라는 요청은 reroll_ip_image다.", {
        "ipId": _STR,
        "prompt": {"type": "string", "description": "영어로 바꿀 점 묘사 (예: wearing a red winter coat, waving)"},
        "description": {"type": "string", "description": "바뀐 뒤 IP의 전체 외형 묘사 (영어): state.ips의 description을 "
                        "이 수정대로 고쳐 쓴 것 (예: brown travel cloak → navy blue travel cloak). 수정이 반영되면 이후 "
                        "액션 샷·트레일러 프롬프트가 이 묘사를 쓴다"},
        "image_model": {"type": "string", "description": "기본 klein9. 사용자가 이미지 수정(i2i)을 하는 스카우트 추가 모델을 "
                                                         "고를 때만 그 id"},
    }, ["ipId", "prompt"]),
    # A request to draw the picture anew has its own tool: the edit would draw from the old picture and be judged
    # as an edit of it
    _spec("reroll_ip_image", "기존 IP의 그림을 처음부터 새로 그리는(다시 뽑기) 작업을 등록하고 바로 돌아온다. 지금 그림을 "
          "레퍼런스로 쓰지 않는 새 그림이라 구도·자세·배경이 모두 새로 나오고, 구도 검사를 통과하면 IP의 version이 1 오른다. "
          "그림을 새로 다시 그려 달라는 요청에 쓴다(한 부분만 바꾸는 수정은 make_ip_variant).", {
        "ipId": _STR,
        "description": {"type": "string", "description": "선택. 새 그림의 전체 외형 묘사 (영어): state.ips의 description을 "
                        "사용자가 새로 말한 모습(구도·배경·크기 등)대로 고쳐 쓴 것. 생략하면 지금 묘사 그대로 한 번 더 그린다"},
    }, ["ipId"]),
    _spec("render_3d", f"IP의 배경을 지운 그림으로 {_STEP['mesh3d']}(GLB 파일)과 {waits.josa(_STEP['render3d'], '을', '를')} 만드는 "
          f"작업을 등록한다. 기본 hunyuan3d는 GPU 서버에서 색과 질감을 입힌 실제 {waits.josa(_STEP['mesh3d'], '을', '를')} 만든 뒤 "
          f"렌더 서버에서 그 {waits.josa(_STEP['render3d'], '을', '를')} 만든다 "
          f"({waits.RENDER_3D}). 캐릭터·사람형 적은 {_STEP['mesh3d']} 앞에 {waits.josa(_STEP['apose'], '이', '가')}, 뒤에 "
          f"{waits.josa(_STEP['rig'], '이', '가')} 붙는다: 단계의 순서는 결과의 steps "
          f"그대로이고, 걸리는 시간은 결과의 typical(등록한 단계만 더한 값)이다. relief는 그림의 실루엣에 두께만 준 빠른 대안({waits.RELIEF}). "
          "IP 이미지가 아직 그려지는 중이어도 등록하면 이미지가 끝난 뒤 자동으로 시작한다. 3D를 다시 만들 때도 지금 그림으로 "
          "이 도구만 다시 부르고 그림을 먼저 고치지 않는다. 배경(usage background) IP는 장면 그림에 두께만 준 판(relief)으로 만든다.", {
        "ipId": _STR,
        "model": {**_enum(RENDER_MODELS), "description": f"hunyuan3d=실제 {_STEP['mesh3d']}(기본), relief=실루엣에 두께만 준 판(빠른 대안)"},
        "rig_only": {"type": "boolean", "description": f"true면 새 {_STEP['mesh3d']} 없이 IP의 지금 {_STEP['mesh3d']}에 "
                                                       f"{_STEP['rig']}만 다시 넣는다(캐릭터·사람형 적, 겉모습 그대로, 수 분). "
                                                       f"{waits.josa(_STEP['rig'], '이', '가')} 들어간 모델에 바닥 판이 붙었다는 불만에 쓴다"},
        "mesh_asset_id": {"type": "string", "description": f"rig_only일 때 선택: {waits.josa(_STEP['rig'], '을', '를')} 넣을 이 IP의 "
                                                           f"이전 3D 버전(glb assetId). 끝나면 그 {waits.josa(_STEP['mesh3d'], '이', '가')} "
                                                           f"IP의 현재 3D가 된다. 생략하면 현재 {_STEP['mesh3d']}"},
    }, ["ipId"]),
    _spec("make_video_shot", "IP 이미지를 첫 프레임으로(ipId 없이 prompt만 주면 텍스트-투-비디오) mediagen GPU 영상 샷 작업을 등록한다 "
          f"(수 분, {waits.VIDEO_BOOT}).", {
        "ipId": {"type": "string", "description": "첫 프레임이 될 IP. 생략하면 prompt만으로 만드는 텍스트-투-비디오"},
        "prompt": {"type": "string", "description": "영어로 카메라 움직임과 동작 묘사"},
        "aspect_ratio": _enum(("16:9", "9:16")),
        "duration": {**_int(2, 20), "description": "초. ltx는 2–20(이어 붙이지 않은 한 번의 생성, 8초 초과는 960x512), minimax-h3와 kandinsky-6-0-video-pro는 5로 고정"},
        "model": {"type": "string", "description": "영상 MCP(list_video_models)의 모델 id. ltx=LTX-2.5(기본), minimax-h3=MiniMax H3, "
                                                   "kandinsky-6-0-video-pro=Kandinsky 6.0 Pro, 그 밖에 MCP에 추가된 모델 id"},
        "last_ip_id": {"type": "string", "description": "선택, minimax-h3만. 마지막 프레임이 될 IP: ipId의 첫 프레임에서 이 IP로 이어지는 영상"},
    }, ["prompt", "aspect_ratio"]),
    _spec("make_action_shot", "IP가 (무기를 들고) 액션하는 스틸을 FLUX.2 klein 9B로 그리고(IP 이미지와 무기 이미지를 레퍼런스로, "
          "IP 버전은 그대로) 그 스틸을 첫 프레임으로 영상 샷을 만드는 작업을 함께 등록하고 바로 돌아온다. "
          "결과는 영상 샷이라 cut_trailer에 넣을 수 있다.", {
        "ipId": {"type": "string", "description": "액션하는 캐릭터·적 IP"},
        "action": {"type": "string", "description": "영어로 동작 묘사 (예: sprinting through a neon alley, swinging the sword)"},
        "weapon_ip_id": {"type": "string", "description": "선택. 손에 든 무기 IP(kind weapon)의 ipId"},
        "opponent_ip_ids": {"type": "array", "maxItems": 2, "items": _STR,
                            "description": "선택. 같은 장면에 함께 나오는 IP(적·캐릭터) 1–2개. scene_kind battle이면 맞서 싸우는 상대, story면 함께하는 인물"},
        "scene_kind": {**_enum(("battle", "story")), "description": "선택. battle(기본)=격돌하는 전투, story=대화·대치·동료애 같은 서사 장면"},
        "scene": {"type": "string", "description": "선택. 영어로 전장·배경 묘사 (예: a burning ruined city at dusk, rain and smoke)"},
        "seconds": {**_int(4, 10), "description": "선택. LTX 샷 길이(초). 기본 5"},
        "model": {"type": "string", "description": "영상 MCP(list_video_models)의 이미지→영상 모델 id. ltx=LTX-2.5(기본, "
                                                   "5초), minimax-h3, kandinsky-6-0-video-pro, 그 밖에 MCP에 추가된 모델 id"},
    }, ["ipId", "action"]),
    _spec("animate_character", "Wan 2.2 Animate로 IP 캐릭터 이미지를 기존 영상 샷의 움직임대로 움직이는 4초 샷 작업을 등록한다. "
          "움직임 샷이 끝나면 자동 시작한다. 결과도 영상 샷이라 cut_trailer에 넣을 수 있다.", {
        "ipId": _STR,
        "driving_shot_job_id": {"type": "string", "description": "움직임을 가져올 make_video_shot(또는 animate_character)의 jobId"},
        "prompt": {"type": "string", "description": "선택. 영어로 장면 묘사"},
    }, ["ipId", "driving_shot_job_id"]),
    video_edit.SPEC,
    _spec("cut_trailer", "영상 샷 작업들을 컬러 그레이딩해 트레일러(+9:16 쇼츠)로 자르는 작업을 등록한다. 샷이 끝나면 자동 실행되므로 샷을 등록한 직후 호출해도 된다.", {
        "shot_job_ids": {"type": "array", "items": _STR, "minItems": 1, "description": "make_video_shot·animate_character의 jobId들"},
        "title": _STR,
        "subtitle": _STR,
        "lut": _enum(LUTS),
        "include_turntable_ip_id": {"type": "string", "description": f"이 IP의 {waits.josa(_STEP['render3d'], '을', '를')} 샷 뒤에 붙인다 (만드는 중이면 끝날 때까지 기다림)"},
        "make_shorts": {"type": "boolean"},
        "intertitles": {"type": "array", "maxItems": 12, "items": _STR,
                        "description": "선택. 스토리 자막 카드: shot_job_ids와 같은 순서로, 그 샷 앞에 2초 검은 화면 자막(한국어 한 줄, 빈 문자열이면 카드 없음)"},
    }, ["shot_job_ids", "title", "subtitle", "lut", "make_shorts"]),
    _spec("make_game", "요청에 맞춘 게임을 만들고 미리보기 URL을 돌려준다. 새 3D 게임은 version 2, engine three와"
          " world(직접 설계한 구조물·IP 배치), mission(순서 있는 미션), mechanics, artDirection을 쓴다."
          " spriteUrl·modelUrl은 넣지 않는다(서버가 선택한 IP 에셋으로 채운다).", {
        "spec": _GAMESPEC,
        "engine": {**_enum(MAKE_GAME_ENGINES), "description": "three=three.js 3D(기본, IP GLB를 3인칭 캐릭터로), phaser=단순 2D, unreal=UE5 고품질 3D(클라우드 스트리밍, 사용자가 Unreal을 원할 때만)"},
        "base_game_id": {**_STR, "description": "기존 게임을 고친 새 버전이면 그 게임의 gameId (게임 버전 목록에 '…의 수정본'으로 이어진다)"},
        "cast_ip_ids": {"type": "array", "items": _STR, "description": "사용자가 지정한 출연 IP. 주면 player·enemies·props·weaponIpId가 모두 이 중에서만 나와야 하고(ipId 없는 절차적 캐릭터 금지), 지정한 IP는 모두 써야 한다"},
    }, ["spec"]),
    _spec("hold_game_request", "주인공의 3D가 끝나지 않아 make_game을 부를 수 없는 게임 요청을 보류한다. 서버가 이번 턴의 요청을 "
          f"기억해 두고, 주인공의 3D({_STEP['rig']}까지)가 끝나면 화면에 '{HELD_BUTTON}' 버튼을 띄워 사용자가 한 번 눌러 그 요청 그대로 게임을 "
          "만들 수 있게 한다. 게임을 요청받은 턴에만 부른다. 3D를 시작하지는 않는다: 주인공의 3D가 없으면 render_3d도 함께 건다. "
          "이미 보류해 둔 요청(state.heldGame)이 있으면 그 요청이 그대로 남는다. 이 도구를 부르지 않고 답에서 요청을 "
          "보류했다고 말하지 않는다.", {
        "ipId": {**_STR, "description": "게임의 주인공이 될 IP (state.ips[].game3d가 ready가 아닌 IP)"},
        "replace": {"type": "boolean", "description": "true = 이번 메시지가 이미 보류해 둔 요청(state.heldGame)과 다른 새 게임 "
                                                      "요청이라 보류를 이 요청으로 바꾼다. 같은 게임을 재촉하는 말이면 생략한다"},
    }, ["ipId"]),
    _spec("get_game_spec", "만들어 둔 게임의 GameSpec 전체를 읽는다. 게임을 고칠 때 이 spec에서 요청한 부분만 바꿔 make_game에 넘긴다.", {
        "gameId": _STR,
    }, ["gameId"]),
    _spec("publish_game", "게임을 게시한다(화면의 '게시하기'와 같다). 영상(트레일러, 쇼츠, 샷)을 게임 시작 전 광고로 붙이고, "
          "N판마다 다시 틀 수 있다.", {
        "gameId": _STR,
        "ad_asset_id": _STR,
        "skip_after_sec": _int(0, 30),
        "ad_every_rounds": {**_int(0, 20), "description": "N판이 끝날 때마다 광고를 다시 튼다 (0 = 시작할 때만). 라이브 방송에서는 같은 때 방송 중 광고가 나간다"},
    }, ["gameId"]),
]

# ── helpers ────────────────────────────────────────────────────────────────────


def _err(code: str, message: str, notice: str = "") -> dict:
    """A refusal. message is the agent's (ids, argument names, what to do next in its turn). notice is the one
    sentence for the person who pressed a card's button (user_text); the toast keeps a refusal's first sentence."""
    return {"error": code, "message": message, **({"notice": notice} if notice else {})}


def _not_found(what: str, value) -> dict:
    # a card that names something the session no longer has is a page that is out of date
    return _err("not_found", f"{what}을(를) 찾을 수 없습니다: {value}. 상태(state)에 있는 id만 쓰세요.",
                tr("화면이 오래돼 {what_ul} 찾지 못했으니 새로 고친 뒤 다시 해 주세요.", what_ul=waits.josa(what, "을", "를")))


# What a refused card button says when its refusal carries no sentence of its own (an argument the page never sends)
REFUSED = "요청을 처리하지 못했으니 화면을 새로 고친 뒤 다시 해 주세요."


def user_text(result: dict) -> str:
    """A tool's refusal as the person who pressed its button reads it (server/app.py: the toast of POST
    /tools/<name> and /publish, the chat line of a button whose tool runs in the background): never the agent's
    copy."""
    return result.get("notice") or tr(REFUSED)


def tool_label(name: str, kind=None) -> str:
    """What the studio calls a tool, in the request's language: the button that does the same on screen (_LABELS; an
    IP made in chat by its kind, _KIND_LABELS)."""
    return i18n.label(_KIND_LABELS.get(str(kind)) if name == "create_ip_asset" and str(kind) in _KIND_LABELS
                      else _LABELS.get(name, name))


def button_line(name: str, result: dict) -> str:
    """The chat line of a card button whose tool did not start (app.run_tool_turn)."""
    label = _LABELS.get(name, name)
    if result.get("error") == "check_failed":  # it ran: the note says what became of its draw
        return f"{i18n.label(label)}: {user_text(result)}"
    return tr("{label_ul} 시작하지 못했어요. {why}", label=i18n.label(label), label_ul=waits.josa(label, "을", "를"),
              why=user_text(result))


def _pick(items: dict, key):
    return items.get(key) if isinstance(key, str) else None  # model-sent ids can be any JSON type


def _text(args: dict, key: str) -> str:
    v = args.get(key)
    return v.strip() if isinstance(v, str) else ""


def _lookup(ctx, session):
    snap = store.snapshot(ctx, session["sessionId"])
    return snap, {i["ipId"]: i for i in snap["ips"]}, {a["assetId"]: a for a in snap["assets"]}


def _concept(session) -> dict:
    return session.get("concept") or {}


def _put_bytes_asset(ctx, session_id, kind, data, ext, content_type, **extra) -> dict:
    asset_id = store.new_id("ast")
    key = s3_key_for(session_id, asset_id, ext)
    ctx.s3.put_object(Bucket=ctx.assets_bucket, Key=key, Body=data, ContentType=content_type)
    return store.put_asset(ctx, session_id, {"assetId": asset_id, "kind": kind, "key": key,
                                             "contentType": content_type, **extra})


def _put_json(ctx, key: str, obj) -> None:
    # no-cache: release.json is rewritten on publish; CloudFront must not keep serving the preview copy
    ctx.s3.put_object(Bucket=ctx.assets_bucket, Key=key, Body=json.dumps(obj, ensure_ascii=False).encode(),
                      ContentType="application/json; charset=utf-8", CacheControl="no-cache")


mimetypes.add_type("model/gltf-binary", ".glb")  # not in Python's table


def _copy(ctx, src_key: str, dst_key: str) -> None:
    """A game folder's copy (runtime file or IP asset). no-cache: CloudFront revalidates it, so a later refresh of the
    same key (game_assets.refresh) shows at once instead of after the edge's default day."""
    ctx.s3.copy_object(CopySource={"Bucket": ctx.assets_bucket, "Key": src_key}, Bucket=ctx.assets_bucket, Key=dst_key,
                       MetadataDirective="REPLACE", CacheControl="no-cache",
                       ContentType=mimetypes.guess_type(dst_key)[0] or "binary/octet-stream")


# ── IP images drawn by GPU jobs ────────────────────────────────────────────────
# An IP made with krea or klein9 exists at once; its picture comes from an image job (ip.imageJobId) that the job
# engine runs in the background. Work that reads the picture (3D, a variant, a derived IP) chains on that job and
# reads its fixed output keys; work that shows it (games, video shots) waits for the user to see it first.


def _jobs(snap) -> dict:
    return {j["jobId"]: j for j in snap["jobs"]}


def _in_flight(job) -> bool:
    return bool(job) and job["status"] in ("queued", "running")


def _image_job(ip, jobs_by_id):
    """The IP's image job (a new IP, a variant or a reroll) while it is still queued or running, else None."""
    job = jobs_by_id.get(ip.get("imageJobId") or "")
    return job if _in_flight(job) else None


def image_state(ip, jobs_by_id):
    """None when the IP's picture is ready; "pending" (its first image is being drawn), "updating" (a new version
    is), "failed" (its only image job failed), "check_failed" (the picture in use failed the composition check: a
    first picture kept that way, or a restored version)."""
    job = jobs_by_id.get(ip.get("imageJobId") or "")
    if _in_flight(job):
        return "updating" if ip.get("imageAssetId") else "pending"
    if job and job["status"] == "failed" and not ip.get("imageAssetId"):
        return "failed"
    return "check_failed" if _check_note(ip, jobs_by_id) else None


def _check_note(ip, jobs_by_id) -> str:
    """The error line of the image job that drew the IP's current picture, when that picture failed its composition
    or edit check (mediagen_image._flag), else "". Said of the picture in use (mediagen_image.note_now)."""
    image = ip.get("imageAssetId")
    drew = next((j for j in jobs_by_id.values() if image and image in (j.get("outputs") or [])), None) or {}
    note = drew.get("error") or ""
    if not note.startswith((mediagen_image.CHECK_FAILED, mediagen_image.EDIT_FAILED)):
        return ""
    return mediagen_image.note_now(note, int(ip.get("version") or 1), drew_current=True)


def job_note(job, ips):
    """A job's error line as the agent reads it (the job card says the same, web/src/types.ts jobNote): an image
    job's check note says which picture its IP uses now (mediagen_image.note_now), any other line is as stored."""
    note, ip = job.get("error"), ips.get(job["input"].get("ipId") or "")
    if not note or not ip or job["kind"] != "image":
        return note
    return mediagen_image.note_now(note, int(ip.get("version") or 1),
                                   drew_current=(ip.get("imageAssetId") or "") in (job.get("outputs") or []))


def _source(sid, ip, jobs_by_id, assets, cut=False):
    """→ (S3 key, deps) of the IP's picture (or its cutout): the image job still drawing it, waited on and read at its
    fixed key, else the current asset. None when there is neither (its image job failed)."""
    job = _image_job(ip, jobs_by_id)
    if job:
        return (mediagen_image.cutout_key if cut else mediagen_image.image_key)(sid, job["jobId"]), [job["jobId"]]
    asset = assets.get(ip.get("cutoutAssetId" if cut else "imageAssetId") or "")
    return (asset["key"], []) if asset else None


def _names(ips) -> str:
    return ", ".join(ip.get("name") or ip["ipId"] for ip in ips)


def _queued_images(jobs_by_id) -> int:
    return sum(1 for j in jobs_by_id.values() if j["kind"] == "image" and _in_flight(j))


def _eta_min(queued: int) -> int:
    return math.ceil((SWAP_SEC + queued * IMAGE_SEC) / 60)


def _no_picture(names: str) -> str:
    return tr("{names}의 그림을 만들지 못했으니 ‘작업 현황’에서 그림 작업을 다시 시도해 주세요.", names=names)


def _image_failed(ips) -> dict:
    return _err("image_failed", f"{_names(ips)}의 이미지 작업이 실패해 이미지가 없습니다. 사용자에게 알리고, 작업 현황에서 "
                                "다시 시도하거나 create_ip_asset으로 새로 만들도록 안내하세요.", _no_picture(_names(ips)))


def _not_ready(ips, jobs_by_id):
    """The clear error for a tool that needs finished pictures (games, video shots), or None when all are ready."""
    pending = [ip for ip in ips if image_state(ip, jobs_by_id) in ("pending", "updating")]
    if pending:
        queued = _queued_images(jobs_by_id)
        return _err("images_pending", f"{_names(pending)}의 이미지를 아직 그리는 중입니다(대기·진행 중인 이미지 {queued}장, "
                                      f"약 {_eta_min(queued)}분). 이 도구를 다시 부르지 말고, 대기 중인 이미지와 예상 시간을 "
                                      "알린 뒤 이미지가 왼쪽에 나타나면 다시 요청해 달라고 안내하세요.",
                    tr("{names}의 그림을 아직 그리는 중이니(약 {minutes}분) 그림이 나온 뒤 다시 눌러 주세요.",
                       names=_names(pending), minutes=_eta_min(queued)))
    failed = [ip for ip in ips if image_state(ip, jobs_by_id) == "failed"]
    return _image_failed(failed) if failed else None


# A 3D chain's steps in order, each by the name its job card has (waits.STEP_LABEL) and with what it usually still
# takes (web/src/types.ts JOB_TYPICAL). The turntable (render3d) does not hold a game back after a mesh: the game
# uses the GLB. A relief (no mesh job) makes its GLB itself.
THREE_D_STEPS = {kind: (waits.STEP_LABEL[kind], waits.THREE_D_TYPICAL[kind][1])
                 for kind in ("apose", "mesh3d", "rig", "render3d")}


def _three_d_jobs(ip_id, jobs_by_id) -> list:
    return [j for j in jobs_by_id.values() if j["kind"] in THREE_D_STEPS and _in_flight(j)
            and (j.get("input") or {}).get("ipId") == ip_id]


def ready_3d_for_game(ip, assets, jobs_by_id) -> bool:
    """The IP's 3D is finished for a game: a GLB (raw or rigged) exists, and no rig is still coming for a model that
    has none yet. A new 3D or a rig redone over an existing one does not hold it back: the current one plays
    meanwhile. A model whose skeleton failed or was refused (refused_skeleton) is finished too: the game takes it
    as it is, without walking motions. The page offers a held game request by the same rule."""
    if not ({ip.get("glbAssetId"), ip.get("riggedGlbAssetId")} - {None}) & set(assets):
        return False
    rigging = any(j["kind"] == "rig" for j in _three_d_jobs(ip["ipId"], jobs_by_id))
    return not (rigging and ip.get("riggedGlbAssetId") not in assets)


def refused_skeleton(ip, assets, jobs_by_id) -> str:
    """Why the IP's model has no skeleton and gets none as it is, in the user's words: the reason of its newest 움직임
    뼈대 job when that job ended as the rig tool's refusal (jobs.REFUSED), else "". Not while the IP still plays an
    earlier model that has its skeleton, and not while a newer skeleton job (a new 3D, a retry) is on its way."""
    if ip.get("riggedGlbAssetId") in assets:
        return ""
    rigs = [j for j in jobs_by_id.values() if j["kind"] == "rig" and (j.get("input") or {}).get("ipId") == ip["ipId"]]
    last = max(rigs, key=lambda j: j.get("createdAt") or "", default=None)
    if not last or last.get("outcome") != jobs.REFUSED or any(_in_flight(j) for j in rigs):
        return ""
    return last.get("reason") or rig_tool.OTHER_REASON


def _no_skeleton(ips, assets, jobs_by_id) -> dict:
    """What a tool's result tells the agent of the IPs (a game's cast, or a hero) whose skeleton was refused: who,
    and what to say and never to say of it (a retry fails the same way). {} when none is."""
    refused = [(ip.get("name") or ip["ipId"], refused_skeleton(ip, assets, jobs_by_id)) for ip in ips]
    refused = [(name, why) for name, why in refused if why]
    if not refused:
        return {}
    who = ", ".join(f"{name}({why})" for name, why in refused)
    return {"noSkeleton": [name for name, _ in refused],
            "message": f"{who}: 이 3D 모델에는 움직임 뼈대를 넣을 수 없어 게임에서 걷고 공격하는 동작 없이 미끄러지듯 움직입니다. "
                       "답에서 그렇게 알리세요. '다시 시도'나 움직임 뼈대만 다시 넣기는 같은 모델이라 똑같이 실패하니 권하지 "
                       f"마세요. 동작을 넣으려면 {rig_tool.PICTURE_NEEDS}으로 다시 뽑은 뒤 3D를 다시 만들어야 한다고 알리세요."}


def game_3d_state(ip, assets, jobs_by_id) -> str:
    """'ready' (ready_3d_for_game), 'running' (a 3D job for it is queued or running) or 'none' (no 3D was started)."""
    if ready_3d_for_game(ip, assets, jobs_by_id):
        return "ready"
    return "running" if _three_d_jobs(ip["ipId"], jobs_by_id) else "none"


def three_d_order(kinds) -> str:
    """These steps of a 3D chain in the order they run, in the cards' names (waits.STEP_LABEL). The turntable and the
    rig both wait for the mesh alone, so they are said together, never one after the other."""
    name = {kind: label for kind, (label, _) in THREE_D_STEPS.items()}
    first = [name[k] for k in ("apose", "mesh3d") if k in kinds]
    last = [name[k] for k in ("render3d", "rig") if k in kinds]
    if len(last) == 2:
        after = f"({waits.josa(name['mesh3d'], '이', '가')} 나오면 함께 시작)" if "mesh3d" in kinds else "(함께 진행)"
        last = [f"{waits.josa(last[0], '과', '와')} {last[1]}{after}"]
    return " → ".join([*first, *last])


# What brings a held game back, as the agent tells it: the turn marks the request (agent._note_hold) and the page
# offers it once the 3D is ready (web/src/api.ts heldGame). Nothing makes the game by itself.
HELD_GAME = (f"3D가 끝나면 화면에 '{HELD_BUTTON}' 버튼이 나타나고, 사용자가 누르면 보류한 요청 그대로 게임을 만듭니다(다시 요청해도 "
             "됩니다). 사용자에게 이 버튼을 알리세요. 게임은 버튼을 누르거나 다시 요청해야 만들어지니 '3D가 끝나면 게임을 "
             "만들겠다'고 약속하지 마세요.")


def held_game(snap: dict):
    """The game request still on hold, or None: the newest game request (a user message marked gameHeld by
    agent._note_hold, or a 게임 설계) when it carries the mark and no game was made after it (the page's rule,
    web/src/api.ts heldGame)."""
    made = max((g.get("createdAt") or "" for g in snap["games"]), default="")
    asked = next((m for m in reversed(snap["messages"])
                  if m["role"] == "user" and (m.get("gameHeld") or m.get("gameDesign"))), None)
    return asked if asked and asked.get("gameHeld") and asked["ts"] > made else None


def offered_3d(ip, assets, jobs_by_id) -> bool:
    """Whether a held game is offered on this IP's 3D, as the page offers it (web/src/api.ts readyIp): the 3D is
    finished for a game (ready_3d_for_game), and not by a skeleton that failed for a reason a retry may pass (the
    page then keeps 다시 시도). A refused skeleton is final (refused_skeleton): the request is offered."""
    if not ready_3d_for_game(ip, assets, jobs_by_id):
        return False
    rigs = [j for j in jobs_by_id.values() if j["kind"] == "rig" and (j.get("input") or {}).get("ipId") == ip["ipId"]]
    last = max(rigs, key=lambda j: j.get("createdAt") or "", default=None)
    failed = bool(last) and last["status"] == "failed" and last.get("outcome") != jobs.REFUSED
    return not (failed and ip.get("riggedGlbAssetId") not in assets)


def held_ready(held: dict, ips: dict, assets: dict, jobs_by_id: dict) -> bool:
    """Whether the game request on hold (held_game) is on offer now: one of the IPs it waits for has its 3D in
    (offered_3d), which is when the page shows its 게임 만들기 (web/src/api.ts heldGame)."""
    waits_for = (held.get("gameHeld") or {}).get("ipIds") or []
    return any(i in ips and offered_3d(ips[i], assets, jobs_by_id) for i in waits_for)


_CAST_LINE = re.compile(r"\[출연 IP cast_ip_ids=([^\]]*)\]")  # the design drawer's line of picked IPs (prompts.py)


def _hold_pool(snap: dict, asked: dict) -> list:
    """The IPs a held game may wait for: those the message picked (its 출연 IP line), else every IP of the session
    that can stand in a game (a background is its scenery)."""
    ips = {ip["ipId"]: ip for ip in snap["ips"]}
    line = _CAST_LINE.search(asked.get("text") or "")
    picked = [ips[i] for i in dict.fromkeys(re.findall(r"ip_[A-Za-z0-9_-]+", line[1])) if i in ips] if line else []
    return picked or [ip for ip in ips.values() if ip.get("usage") != "background"]


def _named(pool: list, asked: dict, said: str) -> list:
    """Those of the pool the reply or the request names."""
    text = f"{said}\n{asked.get('text') or ''}"
    return [ip for ip in pool if (ip.get("name") or "").strip() and ip["name"].strip() in text]


def hold_heroes(snap: dict, asked: dict, said: str = "", sure: bool = False) -> list:
    """The ipIds a game request waits for when the turn itself records the hold (agent._keep_hold). The hero is the
    게임 설계's player; else, of the IPs the message picked (its 출연 IP line) or of the whole session, the characters
    the reply or the request names, else every character; in a session with no character, every IP that can stand
    in a game, where one in 3D is enough (_needs_3d). → those whose 3D is not finished for a game ([] = nothing to
    wait for). sure: only when make_game's 3D rule would refuse the game now whichever of them is its hero (none
    has its 3D), else []."""
    ips = {ip["ipId"]: ip for ip in snap["ips"]}
    assets, jobs_by_id = {a["assetId"]: a for a in snap["assets"]}, _jobs(snap)

    def waiting(pool):
        left = [ip["ipId"] for ip in pool if not ready_3d_for_game(ip, assets, jobs_by_id)]
        return left if not sure or len(left) == len(pool) else []

    player = ips.get((asked.get("gameDesign") or {}).get("playerIpId") or "")
    if player:
        return waiting([player])
    pool = _hold_pool(snap, asked)
    characters = [ip for ip in pool if ip.get("kind") == "character"]
    if not characters:
        left = waiting(pool)
        return left if len(left) == len(pool) else []
    return waiting(_named(characters, asked, said) or characters)


def game_heroes(snap: dict) -> dict:
    """Who can be the hero of a game made in this session, for the page (app.get_session: snapshot.gameHeroes). The
    rule is make_game's own (_needs_3d): any IP that can stand in a game whose 3D is finished; a background never.
    The studio itself takes a character, and in a session with no character every other IP (hold_heroes).
    → ipIds: those heroes; ready: the ones whose 3D is finished for a game (a refused skeleton counts);
    noCharacter: the heroes are other IPs because the session has no character."""
    assets, jobs_by_id = {a["assetId"]: a for a in snap["assets"]}, _jobs(snap)
    pool = [ip for ip in snap["ips"] if ip.get("usage") != "background"]
    characters = [ip for ip in pool if ip.get("kind") == "character"]
    heroes = characters or pool
    return {"ipIds": [ip["ipId"] for ip in heroes],
            "ready": [ip["ipId"] for ip in heroes if ready_3d_for_game(ip, assets, jobs_by_id)],
            "noCharacter": bool(pool) and not characters}


def hold_cast(snap: dict, asked: dict, said: str = "") -> list:
    """The ipIds a game request waits for when its hero's 3D is ready and the reply still says the request is on
    hold: the rest of the cast. Of the IPs the request picked (its 게임 설계 or 출연 IP line) or of the whole session:
    those the reply or the request names whose 3D is not finished, else those whose 3D is being made now ([] =
    nothing to wait for)."""
    ips = {ip["ipId"]: ip for ip in snap["ips"]}
    assets, jobs_by_id = {a["assetId"]: a for a in snap["assets"]}, _jobs(snap)
    design = asked.get("gameDesign") or {}
    cast = [ips[i] for i in design.get("castIpIds") or []
            if isinstance(i, str) and i in ips and ips[i].get("usage") != "background"]
    left = [ip for ip in cast or _hold_pool(snap, asked) if not ready_3d_for_game(ip, assets, jobs_by_id)]
    made_now = [ip for ip in left if game_3d_state(ip, assets, jobs_by_id) == "running"]
    return [ip["ipId"] for ip in _named(left, asked, said) or made_now]


def _waiting_3d(ip, assets, jobs_by_id) -> dict:
    """Where the IP's 3D is, for needs_3d and a held game: its phase (the earliest step still to come), the steps
    still to come in the order they run, what the phase's line says, and about how many minutes those steps take."""
    out = {"ipId": ip["ipId"], "name": ip.get("name") or ip["ipId"], "state": game_3d_state(ip, assets, jobs_by_id)}
    running = _three_d_jobs(ip["ipId"], jobs_by_id)
    if running:
        kinds = {j["kind"] for j in running}
        first = min(running, key=lambda j: list(THREE_D_STEPS).index(j["kind"]))
        out["phase"] = THREE_D_STEPS[first["kind"]][0]
        out["steps"] = three_d_order(kinds)
        gates = [k for k in kinds if k != "render3d" or not kinds & {"apose", "mesh3d"}]  # a relief's GLB is its render
        out["etaMinutes"] = sum(THREE_D_STEPS[k][1] for k in gates)
        if first.get("progress"):
            out["progress"] = str(first["progress"])[:80]
    return out


# make_game's refusals that say a 3D is not there yet (the hero's, a hand weapon's, a set piece's): a game refused
# with one of them waits for 3D. Any other refusal is another reason, and no hold (agent._keep_hold)
WAITS_FOR_3D = ("needs_3d", "missing_weapon_asset", "missing_set_piece_asset")


def _needs_3d(spec, ips, assets, jobs_by_id):
    """make_game's 3D rule, or None when it holds: the player's IP has its 3D finished, and (a v1 player without an IP)
    at least one cast IP in a role does. Backgrounds and set pieces (world.background, world.entities) do not count:
    the game is still played by a flat cutout around them."""
    player = ips.get((spec.get("player") or {}).get("ipId"))
    if player:
        if ready_3d_for_game(player, assets, jobs_by_id):
            return None
        waiting, lead = [player], f"주인공 {player.get('name') or player['ipId']}({player['ipId']})의 3D가 아직 끝나지 않아"
    else:
        cast = [ips[i] for i in dict.fromkeys(
            i for e in [*(spec.get("enemies") or []), *(spec.get("props") or [])] if isinstance(e, dict)
            for i in (e.get("ipId"), e.get("weaponIpId")) if i in ips)]
        if any(ready_3d_for_game(ip, assets, jobs_by_id) for ip in cast):
            return None
        waiting, lead = cast, "출연 IP 중 3D가 끝난 IP가 하나도 없어"
    rows = [_waiting_3d(ip, assets, jobs_by_id) for ip in waiting]

    def line(r):
        if r["state"] == "none":
            return f"{r['name']}({r['ipId']}): 3D를 시작하지 않았습니다"
        return (f"{r['name']}({r['ipId']}): 3D 제작 중({r['phase']} 단계{', ' + r['progress'] if r.get('progress') else ''}, "
                f"약 {r['etaMinutes']}분)")
    # a hero of any kind: a session with no character plays a prop or an enemy (game_heroes)
    text = (f"{lead} 게임을 만들 수 없습니다. 3D가 없는 주인공은 납작한 그림 판으로 나오므로 그런 게임은 만들지 "
            f"않습니다. {'; '.join(map(line, rows)) or '게임에 나올 IP가 없습니다'}. ")
    if any(r["state"] == "running" for r in rows):
        text += "3D가 진행 중이면 이 도구를 다시 부르지 말고 사용자에게 단계와 예상 시간을 알리세요. "
    if any(r["state"] == "none" for r in rows) or not rows:
        text += f"3D를 시작하지 않은 IP는 render_3d로 3D를 시작하세요(주인공 먼저, 전체 보통 {waits.TOTAL}). "
    # no IP to wait for: nothing is held
    text += f"이 게임 요청은 보류해 두었습니다. {HELD_GAME}" if rows else "3D가 끝난 뒤 다시 요청해 달라고 알리세요."
    return {**_err("needs_3d", text), "waiting3d": rows}


def _ip_refs(obj):
    """Every ipId / weaponIpId anywhere in a GameSpec."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("ipId", "weaponIpId") and isinstance(v, str):
                yield v
            else:
                yield from _ip_refs(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _ip_refs(v)


def _subject(ip) -> str:
    """What the composition check expects: a full-body figure (characters, humanoid enemies) or an object."""
    return "figure" if ip.get("kind") == "character" or (ip.get("kind") == "enemy" and ip.get("humanoid", True)) else "object"


def _look(ip) -> str:
    """What an edit keeps besides the change: a figure's face and pose, a creature's design, or an object alone."""
    return "figure" if _subject(ip) == "figure" else "creature" if ip.get("kind") == "enemy" else "object"


def _queue_image(ctx, sid, ip, model, prompt, references, deps, version, **edit):
    """One GPU image job for the IP: a new picture, a variant or a reroll. The caller points the IP at it. An edit
    passes edit (the asked change) and covered (the head is covered): mediagen_image checks the landed draw against
    its reference (bedrock_image.edit_check)."""
    # the job keeps the name of the model that draws, for its card: the catalog's, else the built-in one
    label = _model_label(ctx, model) or mediagen_image.LABELS.get(model, "")
    return jobs.create_job(ctx, sid, "image", "mediagen_image", {
        "ipId": ip["ipId"], "model": model, "prompt": prompt, "references": list(references), "version": version,
        "usage": ip.get("usage", "object"), "subject": _subject(ip), "kind": ip.get("kind"),
        **({"modelLabel": label} if label else {}), **edit}, list(deps))


def _model_label(ctx, model) -> str:
    """The image catalog's display name of a model (a promoted one's too), or "" when it is not listed."""
    try:
        return next((m.get("label") or "" for m in connections.image_catalog(ctx)["models"] if m["id"] == model), "")
    except Exception:  # noqa: BLE001 — the card falls back to its own names
        return ""


def _image_models(ctx) -> list:
    """The image models a picture can use: what the image MCP lists now (list_models, cached) and Bedrock's."""
    return [m["id"] for m in connections.image_catalog(ctx)["models"]] + [STABILITY]


def _on_box(jobs_by_id, model) -> int:
    """The draws a promoted model's own box has to do, the one being registered included."""
    return 1 + sum(1 for j in jobs_by_id.values() if j["kind"] == "image" and _in_flight(j)
                   and j["input"].get("model") == model)


def _box_running(ctx, model):
    """Whether a promoted model's own GPU box is up now, as EC2 says it (the registry is the boxes' tags,
    agents.promoted_boxes): True = running, False = stopped, stopping or still coming up, None = EC2 did not say."""
    try:
        from server import agents  # agents imports this module
        state = next((b.get("state") for b in agents.promoted_boxes(ctx) if b.get("slug") == model), None)
    except Exception:  # noqa: BLE001 — the wait is then told as a range
        return None
    return state == "running" if state else None


def _promoted_eta(ctx, jobs_by_id, model) -> dict:
    """A promoted model's draw keeps its one ETA (the cold box's boot in it, waits.py) in the job's input, so the
    card and the booting line say the figure the chat says. A box that is already up has no boot to tell:
    boxRunning true and no ETA, so its card keeps the usual time. {} for the shared box."""
    if not mediagen_image.promoted(model):
        return {}
    running = _box_running(ctx, model)
    if running:
        return {"boxRunning": True}
    return {"etaMinutes": waits.promoted_image_eta(_on_box(jobs_by_id, model), IMAGE_SEC),
            **({} if running is None else {"boxRunning": False})}


def _queued(jobs_by_id, job) -> dict:
    model = job["input"].get("model")
    if mediagen_image.promoted(model):  # its own box: the one ETA its job keeps, the boot in it unless the box is up
        queued, running = _on_box(jobs_by_id, model), job["input"].get("boxRunning")
        eta = job["input"].get("etaMinutes") or waits.promoted_image_eta(queued, IMAGE_SEC, bool(running))
        wait = waits.promoted_image_wait(job["input"].get("modelLabel") or model, queued, IMAGE_SEC, running)
        return {"jobId": job["jobId"], "status": "queued", "queuedImages": queued, "etaMinutes": eta,
                "message": f"이미지 작업을 등록했습니다. {wait}"}
    queued = _queued_images(jobs_by_id) + 1
    return {"jobId": job["jobId"], "status": "queued", "queuedImages": queued, "etaMinutes": _eta_min(queued),
            "message": f"이미지 작업을 등록했습니다. 대기 중인 이미지 {queued}장, 약 {_eta_min(queued)}분 뒤 왼쪽에 나타납니다."}


# ── tools ──────────────────────────────────────────────────────────────────────


def set_concept(ctx, session, args):
    palette = args.get("palette")
    if not (isinstance(palette, list) and len(palette) == 3 and all(gamespec.is_hex(c) for c in palette)):
        return _err("bad_args", "palette는 #rrggbb 색 3개여야 합니다")
    if args.get("genre") not in gamespec.GENRES:
        return _err("bad_args", f"genre는 {'|'.join(gamespec.GENRES)} 중 하나여야 합니다")
    concept = {k: _text(args, k) for k in ("title", "logline", "style")}
    concept["palette"] = palette
    fields = {"concept": concept, "genre": args["genre"]}
    if session.get("title") == store.DEFAULT_TITLE and concept["title"]:
        fields["title"] = concept["title"]
    store.update_session(ctx, session, **fields)
    return concept


# Upright words in a weapon's description ("vertical, handle at bottom") fight the lying-down framing. Only a clause
# that ends at a comma, a period or the end goes.
_UPRIGHT = re.compile(r"\s*\b(?:" + "|".join((
    r"(?:in )?(?:a )?vertical(?:ly)?(?: orientation| position)?(?: with (?:the )?(?:handle|grip|hilt) (?:at|on) (?:the )?bottom)?",
    r"(?:with )?(?:the )?(?:handle|grip|hilt|pommel) (?:is )?(?:at|on) (?:the )?bottom",
    r"(?:standing |held )?upright",
    r"pointing (?:straight )?(?:down|up)(?:wards?)?")) + r")(?=\s*(?:[,.;]|$))", re.I)
# Camera words ("cinematic", "close-up") zoom a weapon's render in on its hilt
_CAMERA = re.compile(r"\s*\b(?:cinematic(?: lighting| shot| composition| framing)?|(?:extreme )?close[- ]?ups?|"
                     r"macro(?: shot)?|(?:shallow )?depth of field|bokeh)\b", re.I)


def _lying(description: str) -> str:
    """A weapon's description, or the session style, without the upright and camera words that fight its whole
    lying-down framing."""
    text = re.sub(r",(?:\s*,)+", ",", _CAMERA.sub("", _UPRIGHT.sub("", description)))
    return re.sub(r",\s*(?=[.;])", "", text).strip(" ,;.")


def _image_prompt(session, kind, name, description, extra="", humanoid=True, usage="object"):
    """The creation prompt of an IP picture. One subject only: "character sheet" made the wide GPU models draw the
    figure twice and crop the legs. The GPU proxy takes no negative prompt and its frame is a fixed 1216x688, so the
    positive text keeps the sides empty and the whole subject inside with space around it. A weapon standing upright
    in that frame comes out as a close-up of its hilt: weapons lie along the frame (mediagen_image stands the cutout
    up for the 3D mesh and the game's hand), and their prompt opens with the whole weapon seen flat from far away,
    names both ends and drops camera words. Props keep the way they stand, drawn small enough to fit whole; a long
    thin one lies down when its description says so."""
    style = _concept(session).get("style") or DEFAULT_STYLE
    if kind == "prop" and usage == "background":
        return (f"Full environmental scene, {name}: {description}. {style}. {extra}"
                "Wide establishing composition showing the complete location and surrounding environment, "
                "coherent perspective, detailed foreground, middle ground and distant scenery, "
                "preserve the entire scene as a game background, no isolated product shot, no studio backdrop, "
                "no text, no watermark")
    if kind == "character" or (kind == "enemy" and humanoid):  # humanoid enemies get rigged like characters
        return (f"Single full-body shot of ONE character, {name}: {description}. {style}. {extra}"
                "Exactly one figure standing alone in the middle of the wide frame, nobody else in the picture, "
                "empty background on both sides, entire body visible from the top of the head to the soles of the "
                "feet, the figure about two thirds of the frame height with empty space above the head and below "
                "the feet, A-pose: arms held straight out at about 45 degrees from the body, legs "
                "slightly apart, empty open hands, neutral expression, facing the camera, "
                "plain neutral studio background, no duplicates, no turnaround, no text")
    if kind == "weapon":  # grip at the left asked; the cutout stands on the end a vision model sees held
        return (f"Flat lay product render of ONE whole weapon or tool, {name}, seen from straight above and far enough "
                f"away that all of it fits in the wide frame: {_lying(description)}. {_lying(style) or DEFAULT_STYLE}. "
                f"{extra}"
                "Exactly one object lying horizontally across the wide frame, flat on its broad side, grip or handle at "
                "the left end and blade, barrel or head toward the right end, the whole object from end to end inside "
                "the frame: the end of the grip and the tip of the blade, barrel or head both in view with empty "
                "margin beyond them, the object about three quarters of the frame width, no perspective "
                "foreshortening, one single view, isolated, no hands, no character, centered, plain neutral studio "
                "background, no text")
    if kind == "enemy":
        return (f"Single full-body shot of ONE creature or machine, {name}: {description}. {style}. {extra}"
                "Exactly one subject, entire body visible with empty space around it, three-quarter view, centered "
                "with margin, plain neutral studio background, no duplicates, no text")
    return (f"Single product render of ONE object, {name}: {description}. {style}. {extra}"
            "Exactly one object, the whole object from end to end and top to bottom inside the frame with empty space "
            "around it, a tall object shown small enough that its full height fits, no detail close-up beside it, "
            "centered with margin, plain neutral studio background, no text")


# Each names what an edit must not touch. "same face" alone can turn a closed helm into an open one with a face,
# and a keep clause without colors and lighting lets a recolor of one part change the rest.
_KEEP = {"figure": "the same head and face as shown, the same armor, outfit, "
                   "colors and lighting, the same pose and framing",
         # naming a face for a head that shows none invites one, so a covered head is never told of a face
         "covered": "the same helmet or head covering exactly as shown, still closed over the whole head, the same "
                    "armor, outfit, colors and lighting, the same pose and framing",
         "creature": "the same design, colors and lighting, the same pose and framing",
         # naming a face or pose on an object draws a person holding it
         "object": "only the object with no person and no hands, the same object design, colors and lighting, "
                   "the same framing"}
# ... and the background is the reference's own, whatever it is: a first picture is asked for on a plain studio but
# may have scenery, and an edit that takes it away fails the edit check.
_KEEP_BACKGROUND = "the reference image's own background unchanged"
# An edit whose change is the backdrop itself is not told to keep it. Only words that name a backdrop, and only
# where the word is the place: a sky or place word that is the first half of a compound, or stands before a colour,
# an ornament or a piece of clothing, names a look of the subject ("sky-blue cape", "forest green", "a crescent
# moon pendant", "in a desert cloak"); so does "the colour of the sunset". A miss costs nothing (the change leads
# the prompt), a false hit at most the redraw (mediagen_image.KEEP_HARDER).
_LOOK = (r"(?:blue|azure|navy|indigo|teal|cyan|aqua|turquoise|green|emerald|jade|mint|lime|olive|khaki|yellow"
         r"|gold(?:en)?|amber|orange|peach|coral|pink|rose|red|crimson|scarlet|ruby|maroon|purple|violet|plum|lavender"
         r"|magenta|white|ivory|cream|pearl|beige|tan|silver|gr[ae]y|charcoal|black|brown|bronze|copper"
         r"|colou?r(?:ed|s)?|hued?|tint(?:ed)?|ton(?:e|ed|es)|shade[sd]?"
         r"|pattern(?:ed|s)?|print(?:ed|s)?|motifs?|emblems?|symbols?|pendants?|brooch(?:es)?|badges?|crests?|clasps?"
         r"|tattoos?|embroider(?:y|ed)|themed?|styled?|inspired|camo(?:uflage)?"
         r"|cloaks?|capes?|coats?|jackets?|dress(?:es)?|robes?|outfits?|uniforms?|armou?r|garb|attire|gear|hats?|boots"
         r"|gloves|scar(?:f|ves)|guard)")
_AS_LOOK = r"(?!-\w|\s+" + _LOOK + r"\b)"
_SKY = r"(?:horizon|sky|moon|sunset|sunrise)"
_COLOUR_OF = re.compile(r"\bcolou?rs? of (?:(?:the|a|an) )?(?:\w+ )?" + _SKY + r"\b", re.I)
_NAMES_BACKDROP = re.compile(
    r"\b(?:background|backdrop|scenery|landscape|surroundings|skyline|" + _SKY + _AS_LOOK
    + r"|standing (?:in|on|at|before|inside|outside)"
    r"|in (?:a|an|the) [\w ,-]{0,24}?(?:forest|alley|street|city|town|village|room|hall|field|meadow|cave|desert|garden"
    r"|temple|castle|arena|harbou?r|battlefield|ruins|jungle|swamp|mountains?)" + _AS_LOOK + r")\b", re.I)


def _names_backdrop(change: str) -> bool:
    """Whether an edit's change names a backdrop (the place behind the subject), not a look of the subject."""
    return bool(_NAMES_BACKDROP.search(_COLOUR_OF.sub(" ", change)))
# What tells a head the picture shows covered: the IP's name and description (the vision check of the reference
# itself is bedrock_image.edit_check)
_COVERED = re.compile(r"\b(helm|helmet|helmed|visor|visored|mask|masked|faceplate|faceless|robot|robotic|android|"
                      r"cyborg|droid|mech|mecha|automaton|golem)s?\b|투구|헬멧|가면|마스크|복면|로봇|안드로이드|사이보그|기계\s*인간",
                      re.I)


def _covered(ip) -> bool:
    """Whether the IP's head is covered (a helmet, visor, mask, a robot), from its name and description."""
    return bool(_COVERED.search(f"{ip.get('name') or ''} {ip.get('description') or ''}"))


def edit_prompt(name, change, look="figure", style="", covered=False):
    """Image-to-image edit on klein: change only what was asked. The full creation prompt would redraw the whole
    picture, so the instruction carries an explicit keep-everything-else clause for what the IP is (look: figure |
    creature | object; a figure whose head is covered keeps its head covering), the reference's own background
    unless the change names a backdrop, and the art style by the concept's name for it (the GPU box draws with its
    photoreal preset otherwise)."""
    # A long "keep everything exactly" clause makes klein return the reference unchanged: the change has to lead,
    # and "clearly visible" stays on the change alone.
    named = f" ({style.strip().rstrip('.')})" if style and style.strip() else ""
    keep = _KEEP["covered" if covered and look == "figure" else look]
    keep += " and" if _names_backdrop(change) else f", {_KEEP_BACKGROUND} and"
    return (f"{change.strip().rstrip('.')}. Change only that, clearly visible. Everything else stays as in the "
            f"reference image of {name}: {keep} the same art style{named}. No text.")


def _stability_image(ctx, prompt, usage="object"):
    """Stable Image Ultra on Bedrock takes seconds, so it is made inside the call. → (bytes, ext, content_type, meta)."""
    seed = random.randint(0, 4294967294)  # Stability's seed range
    background = usage == "background"
    aspect = "16:9" if background else "1:1"
    negative = "text, watermark, blurry, isolated object, plain studio backdrop" if background else NEGATIVE
    image = generate_image(ctx, prompt, negative, seed, aspect_ratio=aspect, output_format="jpeg")
    return image, "jpg", "image/jpeg", {"prompt": prompt, "seed": seed, "model": "stability-ultra",
                                      **({"usage": usage, "aspectRatio": aspect} if background else {})}


def _store_images(ctx, sid, ip_id, made, usage="object", subject="object", upright=False):
    image, ext, content_type, meta = made
    if usage == "background":
        # A separate paired preview asset for the UI/version helpers: the full image's own bytes, no cutout.
        cut, cut_ext, cut_type, cut_meta = image, ext, content_type, {"backgroundPreserved": True}
    else:  # cleaned for Hunyuan3D; the composition check is recorded (no redraw: Stability is not the one that errs)
        cut, check = cutout.prepare(remove_background(ctx, image), subject)
        cut = cutout.stand_up(cut, grip_side(ctx, image)) if upright else cut  # a lying weapon stands on its grip
        cut_ext, cut_type, cut_meta = "png", "image/png", {}
        meta = {**meta, **({"check": check} if check else {})}
    full = _put_bytes_asset(ctx, sid, "image", image, ext, content_type, ipId=ip_id, meta=meta)
    return full, _put_bytes_asset(ctx, sid, "cutout", cut, cut_ext, cut_type, ipId=ip_id,
                                  meta={"forAssetId": full["assetId"], **cut_meta})


def _versions(assets, ip_id):
    """The IP's image assets, oldest first, each with its version (v1 predates meta.version)."""
    images = sorted((a for a in assets.values() if a.get("kind") == "image" and a.get("ipId") == ip_id),
                    key=lambda a: a.get("createdAt", ""))
    return [(int((a.get("meta") or {}).get("version") or 1), a) for a in images]


def _next_version(assets, ip, jobs_by_id=None):
    """The number a new draw of the IP is saved as: past every version saved and every draw still in flight. A draw
    that failed takes none; retried, it lands as the next free number (mediagen_image._landing_version)."""
    coming = [int(j["input"]["version"]) for j in (jobs_by_id or {}).values()  # being drawn
              if j["kind"] == "image" and _in_flight(j) and j["input"].get("ipId") == ip["ipId"]
              and "version" in j["input"]]
    return max([v for v, _ in _versions(assets, ip["ipId"])] + [int(ip.get("version") or 1)] + coming) + 1


def _cutout_for(assets, image):
    """The cutout made with this image: tagged by forAssetId, else (older assets) the next cutout after it."""
    cut = [a for a in assets.values() if a.get("kind") == "cutout" and a.get("ipId") == image.get("ipId")]
    tagged = [a for a in cut if (a.get("meta") or {}).get("forAssetId") == image["assetId"]]
    later = sorted((a for a in cut if a.get("createdAt", "") >= image.get("createdAt", "")), key=lambda a: a["createdAt"])
    return (tagged or later or [None])[0]


def _same_as(ip) -> str:
    """What a picture drawn from another IP's picture (reference_ip_id) is told to keep of it."""
    return ("Same location and visual design as the reference image. " if ip.get("usage") == "background"
            else "Same character design as the reference image. ")


def create_ip_asset(ctx, session, args):
    kind, name, description = args.get("kind"), _text(args, "name"), _text(args, "description")
    if kind not in IP_KINDS or not name or not description:
        return _err("bad_args", f"kind({'|'.join(IP_KINDS)}), name, description이 필요합니다")
    usage = args.get("usage", "object")
    if usage not in ("object", "background") or (usage == "background" and kind != "prop"):
        return _err("bad_args", "usage는 object|background이며 background는 kind prop에서만 사용할 수 있습니다")
    # humanoid says how an enemy stands, weapon_type which hand rig a weapon takes: sent with another kind each is
    # ignored and the call goes on. Where the argument is read it must still be right: the tool cannot guess how an
    # enemy moves
    extra_fields = {}
    if kind == "enemy":
        humanoid = args.get("humanoid", True)
        if not isinstance(humanoid, bool):
            return _err("bad_args", "humanoid는 true(사람형 적) 또는 false(드론·짐승 같은 비사람형)여야 합니다")
        extra_fields["humanoid"] = humanoid
    if kind == "weapon":
        weapon_type = args.get("weapon_type", "melee")
        if weapon_type not in WEAPON_TYPES:
            return _err("bad_args", "weapon_type은 melee(근접) 또는 gun(총)이어야 합니다")
        extra_fields["weaponType"] = weapon_type
    sid = session["sessionId"]
    snap, ips, assets = _lookup(ctx, session)
    jobs_by_id, references, deps = _jobs(snap), [], []
    ref_id = args.get("reference_ip_id")
    if ref_id:
        ref = _pick(ips, ref_id)
        if not ref:
            return _not_found("레퍼런스 IP", ref_id)
        source = _source(sid, ref, jobs_by_id, assets)  # a reference still being drawn is waited on
        if not source:
            return _image_failed([ref])
        references, deps = [source[0]], source[1]
    model = args.get("image_model") or ("klein9" if references else "krea")
    models = _image_models(ctx)
    if model not in models:
        return _err("bad_args", f"image_model은 {'|'.join(models)} 중 하나여야 합니다")
    if references and model != "klein9" and "i2i" not in connections.image_kinds(ctx, model):
        return _err("bad_args", "레퍼런스 이미지(reference_ip_id)는 klein9(또는 i2i를 하는 추가 모델)만 지원합니다. "
                                "image_model을 klein9로 하거나 빼세요.")
    extra = _same_as({"usage": usage}) if references else ""
    prompt = _image_prompt(session, kind, name, description, extra, extra_fields.get("humanoid", True), usage)
    ip = {"ipId": store.new_id("ip"), "kind": kind, "name": name, "description": description,
          "role": _text(args, "role"), "version": 1, **({"usage": usage} if "usage" in args else {}), **extra_fields}
    if model == "stability-ultra":
        full, cut = _store_images(ctx, sid, ip["ipId"], _stability_image(ctx, prompt, usage), usage, _subject(ip),
                                  kind == "weapon")
        store.put_ip(ctx, sid, {**ip, "imageAssetId": full["assetId"], "cutoutAssetId": cut["assetId"]})
        check = full["meta"].get("check") or {}  # a first picture is kept even when it fails: the agent says so
        return {"ipId": ip["ipId"], "imageUrl": full["url"], "cutoutUrl": cut["url"], "imageModel": model,
                **({"message": mediagen_image.check_note(check), "notice": tr(NOTICE_CHECK_FAILED_FIRST)}
                   if check.get("ok") is False else {})}
    job = _queue_image(ctx, sid, ip, model, prompt, references, deps, 1, **_promoted_eta(ctx, jobs_by_id, model))
    store.put_ip(ctx, sid, {**ip, "imageJobId": job["jobId"]})  # the IP exists now; its picture lands with the job
    return {"ipId": ip["ipId"], "imageModel": model, **_queued(jobs_by_id, job)}


# klein tends to open a closed helm into a face, and the storyboard MCP's start_image takes no mask. A promoted i2i
# model that keeps the head's structure takes a covered head's edit, and a klein edit whose check finds a covered
# head turned into a face is redrawn on it (input headModel, mediagen_image.draw_model). The edit check stays on.
COVERED_EDIT_MODELS = ("qwen-image-2-1-7b",)  # preferred in order; else any other promoted i2i model


def _head_model(ctx):
    """→ (id, label) of the promoted i2i model a covered head's edit goes to, or (None, None)."""
    try:
        rows = [m for m in connections.image_catalog(ctx)["models"]
                if m.get("promoted") and "i2i" in (m.get("kinds") or [])]
    except Exception:  # noqa: BLE001 — klein as before
        return None, None
    row = next((m for want in COVERED_EDIT_MODELS for m in rows if m["id"] == want), rows[0] if rows else None)
    return (row["id"], row.get("label") or row["id"]) if row else (None, None)


EDIT_CHECKED = ("v{version}는 수정 검사(요청 밖 변경, 투구·가면 머리가 얼굴로 바뀌었는지 등)를 통과해야 IP 그림이 됩니다. "
                "통과하지 못하면 지금 그림(v{current})이 그대로 남고 채팅에 따로 알립니다. 답에서 v{version}로 바뀐다고 "
                "단정하지 말고 '검사를 통과하면 v{version}로 바뀐다'고 말하세요.")


_STOP = frozenset("the a an and or of to with into from in on at by for its his her their this that make change "
                  "turn give add adds now new more less very same color colour colored coloured instead wearing "
                  "wears replace replaced keep only".split())


def _words(text: str) -> set:
    return {w for w in re.findall(r"[a-z]+", text.lower()) if len(w) > 2 and w not in _STOP}


def merge_edit(description: str, change: str) -> str:
    """The IP's description after an edit the agent gave no rewrite for: the clauses (comma parts) that name what
    the change names give way to the change, the first clause (the subject) is always kept, the change comes last."""
    change = change.strip().rstrip(".")
    if not change:
        return description
    named = _words(change)
    parts = [p.strip() for p in (description or "").split(",") if p.strip()]
    kept = parts[:1] + [p for p in parts[1:] if not (_words(p) & named)]
    return ", ".join(kept + [change])


def description_of(ip, image) -> str:
    """What one picture of the IP shows, in words: the image's saved description (an edit that landed saves the
    description after the change), an older edit's change merged into the IP's, else the IP's own description."""
    meta = (image or {}).get("meta") or {}
    base = ip.get("description") or ""
    return meta.get("description") or (merge_edit(base, meta["edit"]) if meta.get("edit") else base)


def current_description(ip, assets) -> str:
    """What the IP's current picture shows, in words (description_of)."""
    return description_of(ip, assets.get(ip.get("imageAssetId") or ""))


def make_ip_variant(ctx, session, args):
    snap, ips, assets = _lookup(ctx, session)
    ip = _pick(ips, args.get("ipId"))
    if not ip:
        return _not_found("IP", args.get("ipId"))
    change = _text(args, "prompt")
    if not change:
        return _err("bad_args", "prompt(바꿀 점)가 필요합니다")
    sid, jobs_by_id = session["sessionId"], _jobs(snap)
    source = _source(sid, ip, jobs_by_id, assets)  # edits in a row: each one starts from the one before
    if not source:
        return _image_failed([ip])
    covered = _look(ip) == "figure" and _covered(ip)
    prompt = edit_prompt(ip["name"], change, _look(ip), _concept(session).get("style") or "", covered)
    edit = {"edit": change, "covered": covered}  # checked against its reference when it lands
    described = _text(args, "description") or merge_edit(current_description(ip, assets), change)
    if ip.get("usage") == "background":
        prompt = (f"{change}. Make this change clearly visible in the environmental scene {ip['name']}. "
                  "Preserve the complete location, wide scene composition, surrounding scenery and art style "
                  "of the reference. No isolated product shot, no studio backdrop, no text.")
        edit = {}  # a scene: the change may be the scenery itself
    chosen = args.get("image_model")
    model = chosen or "klein9"  # a promoted model edits only if it does i2i (agents.py trial)
    if model != "klein9" and "i2i" not in connections.image_kinds(ctx, model):
        edits = ["klein9"] + [m["id"] for m in connections.image_catalog(ctx)["models"]
                              if m.get("promoted") and "i2i" in (m.get("kinds") or [])]
        return _err("bad_args", f"image_model은 이미지 수정(i2i)을 하는 {'|'.join(edits)} 중 하나여야 합니다")
    head, label = _head_model(ctx) if edit and _look(ip) == "figure" and not chosen else (None, None)
    note = ""
    if head:  # klein first; a covered head it turns into a face is redrawn on that model
        edit.update(headModel=head, headLabel=label)
    if head and covered:  # the user picked no model: the covered head goes to the model that keeps it
        model = head
        note = f"투구·가면으로 가려진 머리를 지키려고 FLUX.2 klein 대신 {label}로 수정합니다."  # its ETA: _queued
    version = _next_version(assets, ip, jobs_by_id)
    job = _queue_image(ctx, sid, ip, model, prompt, [source[0]], source[1], version, description=described, **edit,
                       **_promoted_eta(ctx, jobs_by_id, model))
    store.update_ip(ctx, sid, ip["ipId"], imageJobId=job["jobId"])
    out = {"ipId": ip["ipId"], "version": version, **_queued(jobs_by_id, job), **({"model": model} if note else {})}
    if edit:  # it lands only if the check passes: the reply must not promise it
        checked = EDIT_CHECKED.format(version=version, current=int(ip.get("version") or 1))
        out["message"] = " ".join(m for m in (out["message"], note, checked) if m)
    return out


def render_3d(ctx, session, args):
    snap, ips, assets = _lookup(ctx, session)
    ip = _pick(ips, args.get("ipId"))
    if not ip:
        return _not_found("IP", args.get("ipId"))
    palette = _concept(session).get("palette") or [DEFAULT_ACCENT]
    accent = palette[0] if gamespec.is_hex(palette[0]) else DEFAULT_ACCENT
    model = args.get("model", "hunyuan3d")
    sid, jobs_by_id = session["sessionId"], _jobs(snap)
    if args.get("rig_only") is True:
        return _rig_only(ctx, sid, ip, assets, jobs_by_id, args.get("mesh_asset_id"))
    # checked where a model is made: the skeleton alone makes none, and a whole scene is a panel whatever is asked
    if model not in RENDER_MODELS and ip.get("usage") != "background":
        return _err("bad_args", f"model은 {'|'.join(RENDER_MODELS)} 중 하나여야 합니다")
    source = _source(sid, ip, jobs_by_id, assets, cut=True)  # an image still being drawn: the chain waits for it
    if not source:
        return _image_failed([ip])
    cutout_key, image_deps = source
    note = "" if image_deps else _check_note(ip, jobs_by_id)  # a picture still being drawn is judged when it lands
    edit = note.startswith(mediagen_image.EDIT_FAILED)  # which check: a cut picture, or an edit that changed too much
    warning = {"warning": f"{note} 이 그림으로 만든 3D는 "
                          + ("요청하지 않은 변경까지 그대로 담습니다. " if edit else "잘린 모양 그대로 나옵니다. ")
                          + "사용자에게 알리고 다시 뽑기를 권하세요.",
               "notice": tr(NOTICE_EDIT_FAILED_3D) if edit else tr(NOTICE_CHECK_FAILED_3D)} if note else {}
    background = ip.get("usage") == "background"  # a whole scene: Hunyuan3D makes one object, a scene comes out in pieces
    if model == "relief" or background:
        job = jobs.create_job(ctx, sid, "render3d", "deadline",
                              {"ipId": ip["ipId"], "cutoutKey": cutout_key, "accent": accent, "model": "relief"}, image_deps)
        return {"jobId": job["jobId"], **({"model": "relief", "message": BACKGROUND_3D, "notice": _notice_background_3d()}
                                          if background else warning)}
    humanoid = ip.get("kind") == "character" or ip.get("humanoid") is True
    mesh_deps = image_deps
    if humanoid:  # klein redraws it full-length in the rig's A-pose first (Krea ignores pose and framing)
        pose = jobs.create_job(ctx, sid, "apose", "apose", {"ipId": ip["ipId"], "name": ip.get("name", ""),
                               "imageKey": _source(sid, ip, jobs_by_id, assets)[0]}, image_deps)
        cutout_key, mesh_deps = pose_key(sid, pose["jobId"]), [pose["jobId"]]
    # the GPU mesh next; the Blender turntable waits for it and renders the GLB it collected
    mesh = jobs.create_job(ctx, sid, "mesh3d", "img3d",
                           {"ipId": ip["ipId"], "cutoutKey": cutout_key, "model": "hunyuan3d"}, mesh_deps)
    Img3dProvider().register(ctx, sid, mesh)  # its place in the GPU queue is the request's, not the first poll's
    job = jobs.create_job(ctx, sid, "render3d", "deadline",
                          {"ipId": ip["ipId"], "glbKey": glb_key(sid, mesh["jobId"]), "accent": accent,
                           "model": "hunyuan3d"}, [mesh["jobId"]])
    rig = (jobs.create_job(ctx, sid, "rig", "rig", {"ipId": ip["ipId"], "glbKey": glb_key(sid, mesh["jobId"])},
                           [mesh["jobId"]]) if humanoid else None)  # auto-rig onto the UAL skeleton
    # the ids in the order their jobs run, that order in words (three_d_order) and what these steps usually take
    # together: the agent reads them off here
    kinds = ("apose", "mesh3d", "render3d", "rig") if humanoid else waits.UNRIGGED
    return {**({"imageJobId": image_deps[0]} if image_deps else {}), **({"poseJobId": pose["jobId"]} if humanoid else {}),
            "meshJobId": mesh["jobId"], "jobId": job["jobId"], **({"rigJobId": rig["jobId"]} if rig else {}),
            "steps": ("이미지 → " if image_deps else "") + three_d_order(kinds),
            "typical": f"{_STEP['render3d']}까지 전체 보통 {waits.chain_total(kinds)}", **warning}


def _rig_only(ctx, sid, ip, assets, jobs_by_id, mesh_id):
    """render_3d rig_only: rig an existing Hunyuan3D mesh of the IP again (its current one, or an earlier one), so a
    fixed slab cleanup reaches it without a new mesh that would change the look. An earlier mesh becomes the IP's
    current 3D, with its turntable and poster, when the rig lands (jobs.py applies the rig job's ipLinks)."""
    name = ip.get("name", ip["ipId"])
    if not (ip.get("kind") == "character" or ip.get("humanoid") is True):
        return _err("bad_args", f"{name}에는 {waits.josa(_STEP['rig'], '을', '를')} 넣지 않습니다(캐릭터와 사람형 적에만 넣습니다)",
                    tr("{name}에는 {step_ul} 넣지 않아요(캐릭터와 사람형 적에만 넣어요).", name=name,
                       step=i18n.label(_STEP["rig"]), step_ul=waits.josa(_STEP["rig"], "을", "를")))
    mesh_id = mesh_id if mesh_id is not None else ip.get("glbAssetId")
    mesh = _pick(assets, mesh_id)
    made_by = jobs_by_id.get((mesh or {}).get("jobId")) or {}
    if not mesh or mesh.get("kind") != "glb" or mesh.get("ipId") != ip["ipId"] or made_by.get("kind") != "mesh3d":
        return _err("bad_args", f"{name}의 {waits.josa(_STEP['mesh3d'], '을', '를')} 찾을 수 없습니다: {mesh_id}. "
                                "mesh_asset_id는 이 IP의 3D 버전 중 하나여야 하고, 없으면 render_3d로 먼저 만드세요.",
                    tr("{name}의 {step_i} 아직 없으니 ‘{button}’를 먼저 눌러 주세요.", name=name,
                       step=i18n.label(_STEP["mesh3d"]), step_i=waits.josa(_STEP["mesh3d"], "이", "가"),
                       button=tool_label("render_3d")))
    links = {}
    if mesh_id != ip.get("glbAssetId"):
        links["glbAssetId"] = mesh_id
        turn = next((j for j in jobs_by_id.values() if j["kind"] == "render3d" and j.get("status") == "done"
                     and j["input"].get("glbKey") == mesh["key"]), {})
        for asset_id in [*made_by.get("outputs", []), *turn.get("outputs", [])]:  # the turntable's poster wins
            kind = (assets.get(asset_id) or {}).get("kind")
            if kind in ("turntable", "poster"):
                links[jobs.IP_LINKS[kind]] = asset_id
    job = jobs.create_job(ctx, sid, "rig", "rig", {"ipId": ip["ipId"], "glbKey": mesh["key"],
                                                   **({"ipLinks": links} if links else {})}, [])
    return {"rigJobId": job["jobId"], "meshAssetId": mesh_id}


def make_video_shot(ctx, session, args):
    snap, ips, assets = _lookup(ctx, session)
    ip, last = _pick(ips, args.get("ipId")), _pick(ips, args.get("last_ip_id"))
    if args.get("ipId") and not ip:  # no ipId: text-to-video
        return _not_found("IP", args.get("ipId"))
    if args.get("last_ip_id") and not last:
        return _not_found("마지막 프레임 IP", args.get("last_ip_id"))
    blocked = _not_ready([x for x in (ip, last) if x], _jobs(snap))  # first/last frames need finished images
    if blocked:
        return blocked
    prompt = _text(args, "prompt")
    aspect, model = args.get("aspect_ratio", "16:9"), args.get("model", "ltx")
    duration = args.get("duration", 5)
    if not prompt or aspect not in ("16:9", "9:16"):
        return _err("bad_args", "prompt가 필요하고 aspect_ratio는 16:9|9:16이어야 합니다")
    bad = mediagen_video.shot_model_error(ctx, model, "i2v" if ip else "t2v", aspect)  # the models the video MCP lists
    if bad:
        return _err("bad_args", bad, tr(NOTICE_SHOT_MODEL))
    if last and not (ip and mediagen_video.takes_last_frame(ctx, model)):
        return _err("bad_args", "last_ip_id(마지막 프레임)는 ipId(첫 프레임)와 함께, 마지막 프레임을 받는 모델(minimax-h3)에만 씁니다")
    # a model with one length makes that length whatever is asked: only a model that makes what is asked reads it
    if model not in FIXED_SECONDS and (isinstance(duration, bool) or not isinstance(duration, int) or not 2 <= duration <= 20):
        return _err("bad_args", "duration은 2–20 사이 정수(초)여야 합니다")
    seconds = FIXED_SECONDS.get(model, duration)
    job = jobs.create_job(ctx, session["sessionId"], "shot", "mediagen_video", {
        **({"ipId": ip["ipId"], "imageKey": assets[ip["imageAssetId"]]["key"]} if ip else {}),  # full image, not the cutout
        **({"lastIpId": last["ipId"], "lastImageKey": assets[last["imageAssetId"]]["key"]} if last else {}),
        "prompt": prompt, "aspect_ratio": aspect, "seconds": seconds, "model": model}, [])
    # seconds, model: what the shot was registered with, so the reply does not promise the length that was asked
    # of a fixed-length model
    return {"jobId": job["jobId"], "seconds": seconds, "model": model}


def make_action_shot(ctx, session, args):
    snap, ips, assets = _lookup(ctx, session)
    ip = _pick(ips, args.get("ipId"))
    if not ip:
        return _not_found("IP", args.get("ipId"))
    action = _text(args, "action")
    if not action:
        return _err("bad_args", "action(영어 동작 묘사)이 필요합니다")
    model = args.get("model", "ltx")
    bad = mediagen_video.shot_model_error(ctx, model, "i2v")  # the models the video MCP lists: the still → video
    if bad:
        return _err("bad_args", bad, tr(NOTICE_SHOT_MODEL))
    involved = [ip, _pick(ips, args.get("weapon_ip_id")), *(_pick(ips, o) for o in (args.get("opponent_ip_ids") or [])[:2])]
    blocked = _not_ready([x for x in involved if x], _jobs(snap))
    if blocked:
        return blocked
    references = [assets[ip["imageAssetId"]]["key"]]  # S3 keys: the image job hands the GPU their public URLs
    holding = ""
    weapon_id = args.get("weapon_ip_id")
    if weapon_id:
        weapon = _pick(ips, weapon_id)
        if not weapon:
            return _not_found("무기 IP", weapon_id)
        if weapon.get("kind") != "weapon":
            return _err("bad_args", f"{weapon.get('name', weapon_id)}은(는) 무기(kind weapon)가 아닙니다. 무기 IP의 ipId를 쓰세요.")
        references.append(assets[weapon["imageAssetId"]]["key"])
        holding = f", holding {weapon['name']} ({current_description(weapon, assets)}) from the second reference image in the right hand"
    opponents = []
    for oid in (args.get("opponent_ip_ids") or [])[:2]:
        other = _pick(ips, oid)
        if not other or other["ipId"] == ip["ipId"] or other.get("kind") not in ("character", "enemy"):
            return _not_found("상대 IP(캐릭터·적)", oid)
        references.append(assets[other["imageAssetId"]]["key"])
        opponents.append(other)
    style = _concept(session).get("style") or DEFAULT_STYLE
    looks = current_description(ip, assets)  # the edited version's look, not v1's words
    scene = _text(args, "scene")
    story = args.get("scene_kind") == "story"
    if opponents and story:  # a story beat: the same people, no fight
        first = 3 if weapon_id else 2
        others = "; ".join(f"{o['name']} exactly as reference image {first + i}: {current_description(o, assets)}"
                           for i, o in enumerate(opponents))
        prompt = (f"Cinematic story scene: {ip['name']} {action}{holding}, together with {', '.join(o['name'] for o in opponents)}. "
                  f"{ip['name']} is the same character as the first reference image: {looks}. "
                  f"Others: {others}. {scene or 'an atmospheric location that fits the story'}. {style}. "
                  "Each character appears once, expressive faces and body language, film still, shallow depth of field, "
                  "cinematic lighting, no text")
    elif opponents:  # a battle: every fighter keeps the look of its own reference image
        first = 3 if weapon_id else 2
        foes = "; ".join(f"{o['name']} exactly as reference image {first + i}: {current_description(o, assets)}"
                         for i, o in enumerate(opponents))
        prompt = (f"Epic battle scene: {ip['name']} {action}{holding}, fighting {', '.join(o['name'] for o in opponents)}. "
                  f"{ip['name']} is the same character as the first reference image: {looks}. "
                  f"Opponents: {foes}. {scene or 'a war-torn battlefield with smoke, sparks and debris'}. {style}. "
                  "Each fighter appears once, full bodies in frame, clashing weapons, dramatic lighting, cinematic wide shot, "
                  "motion and energy, no text")
    else:
        prompt = (f"{ip['name']} {action}, dynamic action pose{holding}. The same character as the first reference image: "
                  f"{looks}. {scene + '. ' if scene else ''}{style}. Exactly one character, full body in frame, "
                  "cinematic wide shot, motion and energy, detailed environment background, no text")
    sid = session["sessionId"]
    still = jobs.create_job(ctx, sid, "image", "mediagen_image", {  # the still under the IP; the shot starts from it
        "ipId": ip["ipId"], "model": "klein9", "prompt": prompt, "references": references, "asset": "action_image",
        "meta": {"action": action, **({"weaponIpId": weapon_id} if weapon_id else {}),
                 **({"opponentIpIds": [o["ipId"] for o in opponents]} if opponents else {})}}, [])
    seconds = FIXED_SECONDS.get(model, ACTION_SHOT_SECONDS)
    if model == "ltx" and isinstance(args.get("seconds"), int) and not isinstance(args.get("seconds"), bool):
        seconds = min(10, max(4, args["seconds"]))
    job = jobs.create_job(ctx, sid, "shot", "mediagen_video", {
        "ipId": ip["ipId"], "imageKey": mediagen_image.image_key(sid, still["jobId"]), "stillJobId": still["jobId"],
        "prompt": (f"{ip['name']} {action}" + (
            f" with {', '.join(o['name'] for o in opponents)}, subtle natural motion, a slow cinematic camera move" if opponents and story
            else f" against {', '.join(o['name'] for o in opponents)}, weapons clash, sparks fly, the fighters trade blows, "
                 "fluid dynamic motion, the camera tracks the action" if opponents
            else ", fluid dynamic motion, the camera tracks the action")),
        "aspect_ratio": "16:9", "seconds": seconds, "model": model}, [still["jobId"]])
    return {"stillJobId": still["jobId"], "jobId": job["jobId"], "status": "queued"}


def animate_character(ctx, session, args):
    snap, ips, assets = _lookup(ctx, session)
    ip = _pick(ips, args.get("ipId"))
    if not ip:
        return _not_found("IP", args.get("ipId"))
    blocked = _not_ready([ip], _jobs(snap))
    if blocked:
        return blocked
    driving = _pick({j["jobId"]: j for j in snap["jobs"]}, args.get("driving_shot_job_id"))
    if not driving or driving["kind"] != "shot":
        return _not_found("영상 샷 작업", args.get("driving_shot_job_id"))
    if driving["status"] == "failed":
        return _err("bad_args", "실패한 샷은 움직임으로 쓸 수 없습니다. 다른 샷의 jobId를 쓰세요.")
    job = jobs.create_job(ctx, session["sessionId"], "shot", "mediagen_video", {
        "ipId": ip["ipId"], "imageKey": assets[ip["imageAssetId"]]["key"], "model": "wan-animate",
        "driving_shot_job_id": driving["jobId"], "prompt": _text(args, "prompt"), "seconds": ANIMATE_SECONDS,
        "aspect_ratio": driving["input"].get("aspect_ratio", "16:9")}, [driving["jobId"]])
    return {"jobId": job["jobId"]}


def cut_trailer(ctx, session, args):
    snap, ips, _ = _lookup(ctx, session)
    jobs_by_id = {j["jobId"]: j for j in snap["jobs"]}
    shot_ids = args.get("shot_job_ids")
    if not isinstance(shot_ids, list) or not shot_ids:
        return _err("bad_args", "shot_job_ids에 make_video_shot·animate_character의 jobId를 하나 이상 넣어야 합니다")
    for job_id in shot_ids:
        dep = _pick(jobs_by_id, job_id)
        if not dep or dep["kind"] != "shot":
            return _not_found("영상 샷 작업", job_id)
    lut = args.get("lut", "none")
    if lut not in LUTS:
        return _err("bad_args", f"lut는 {'|'.join(LUTS)} 중 하나여야 합니다")
    inp = {"shot_job_ids": list(shot_ids), "lut": lut, "make_shorts": args.get("make_shorts") is True,
           "title": _text(args, "title") or _concept(session).get("title") or session["title"],
           "subtitle": _text(args, "subtitle")}
    titles = args.get("intertitles") if isinstance(args.get("intertitles"), list) else []
    beats = {sid_: t.strip()[:60] for sid_, t in zip(shot_ids, titles) if isinstance(t, str) and t.strip()}
    if beats:
        inp["intertitles"] = beats
    deps = list(shot_ids)
    ip_id = args.get("include_turntable_ip_id")
    if ip_id:
        ip = _pick(ips, ip_id)
        if not ip:
            return _not_found("IP", ip_id)
        inp["include_turntable_ip_id"] = ip_id
        if ip.get("turntableAssetId"):
            inp["extra_asset_ids"] = [ip["turntableAssetId"]]
        else:  # wait for the render in flight; jobs.py binds the turntable when it lands
            renders = [j for j in snap["jobs"] if j["kind"] == "render3d" and j["status"] != "failed"
                       and j["input"].get("ipId") == ip_id]
            if not renders:
                return _err("bad_args", f"{ip.get('name', ip_id)}의 {waits.josa(_STEP['render3d'], '이', '가')} 없습니다. render_3d를 먼저 호출하세요.")
            deps.append(renders[-1]["jobId"])
    job = jobs.create_job(ctx, session["sessionId"], "trailer", "ffmpeg", inp, deps)
    return {"jobId": job["jobId"]}


# three.js runtime (game3d/), uploaded next to the Phaser one; make_game defaults to it.
RUNTIME3D_PREFIX = os.environ.get("RUNTIME3D_PREFIX", "runtime3d/v1/")
RUNTIME3D_FILES = ("index.html", "runtime3d.js", "world.js", "anim.js", "ualclips.js", "sf.js", "rpg.js", "gamespec3d.js",
                   "authored-contract.js", "city-contract.js", "background-data.js", "background.js",
                   "mission.js", "authored.js", "biome.js", "sky.js", "arpg.js", "arpg-data.js", "ui.css")
CITY_RUNTIME_FILES = ("city.js", "city-controller.js", "city-layout.js", "race.js", "carrig.js")
TRACK_RUNTIME_FILES = ("track.js", "race.js", "city-controller.js", "carrig.js")  # open-track racing
DEFAULT_ENGINE = "three"


def _parse_spec_text(text: str):
    """A JSON object from model text: exact, or the first object followed only by stray closing braces."""
    try:
        return json.loads(text)
    except ValueError:
        pass
    try:
        obj, end = json.JSONDecoder().raw_decode(text.strip())
        return obj if not text.strip()[end:].strip(" \n\t}") else text
    except ValueError:
        return text


def make_game(ctx, session, args):
    from server.city_contract import is_city_request

    raw = args.get("spec")
    if isinstance(raw, str):  # Converse hands a long nested object over as text when its braces are slightly off
        raw = _parse_spec_text(raw)
    # A new authored game names its engine in the tool's own argument (default three) and leaves spec.engine out,
    # but the validator asks for it in the spec: the tool fills it in. The engine asked for is still checked below
    # (unsupported_authored_engine), and a spec that names another engine stays invalid.
    if isinstance(raw, dict) and raw.get("version") == 2 and raw.get("engine") is None:
        raw = {**raw, "engine": DEFAULT_ENGINE}
    spec, errors = gamespec.validate_spec(raw)
    if errors:
        return {"error": "invalid_spec", "message": "GameSpec 검증 실패: " + "; ".join(errors), "errors": errors}
    engine = args.get("engine") or spec.get("engine") or DEFAULT_ENGINE
    if engine not in MAKE_GAME_ENGINES:
        return _err("bad_args", f"engine은 {'|'.join(MAKE_GAME_ENGINES)} 중 하나여야 합니다")
    if spec["version"] == 2 and engine != "three":
        return _err("unsupported_authored_engine", "직접 설계한 월드와 단계별 미션은 현재 three 3D 엔진으로 실행됩니다")
    design = args.get("_game_design")
    source_prompt = design.get("prompt") if isinstance(design, dict) else args.get("_source_prompt")
    city_mode = spec["version"] == 2 and "city" in spec.get("world", {})
    track_mode = spec["version"] == 2 and "track" in spec.get("world", {})  # an open-track race is not a city game
    if is_city_request(source_prompt) and not city_mode and not track_mode:
        return _err("city_world_required", "도시·오픈월드 요청은 world.city와 300–1200m 월드가 필요합니다. 작은 아레나로 대체할 수 없습니다")
    snap, ips, assets = _lookup(ctx, session)
    picked = [args.get("cast_ip_ids"), (design or {}).get("castIpIds")]
    # model-sent ids can be any JSON type (an object is unhashable): strings only, the cast check below says bad_args
    named = [*_ip_refs(spec), *(i for ids in picked if isinstance(ids, list) for i in ids if isinstance(i, str))]
    blocked = _not_ready([ips[i] for i in dict.fromkeys(named) if i in ips], _jobs(snap))
    if blocked:  # images still being drawn: the game waits for them instead of shipping without them
        return blocked
    # the hero is an IP that can stand in a game (game_heroes): a whole scene is its scenery, as a held request's
    # heroes (_hold_pool) and the page's have it
    if (ips.get((spec.get("player") or {}).get("ipId")) or {}).get("usage") == "background":
        return _err("background_player", "배경(장면 전체) IP는 주인공이 될 수 없습니다. player에는 캐릭터를, 세션에 캐릭터가 "
                                         "없으면 다른 IP(적·소품·무기)를 쓰고, 배경은 world.background에 넣으세요.")
    if design:
        if spec["version"] != 2:
            return _err("authored_world_required", "사용자 게임 설계는 version 2의 world와 mission으로 만들어야 합니다")
        role_problems = game_design.role_errors(spec, design)
        if role_problems:
            return {"error": "cast_role_mismatch", "message": "; ".join(role_problems), "errors": role_problems}
    cast = args.get("cast_ip_ids")
    if design and design.get("castIpIds"):
        cast = design["castIpIds"]
    if cast == []:  # a list that names nobody picks no cast: the game is made as with no list
        cast = None
    if cast is not None:  # only the IPs the user picked appear in this game
        if not isinstance(cast, list) or not cast or not all(isinstance(i, str) for i in cast):
            return _err("bad_args", "cast_ip_ids는 ipId 문자열 목록이어야 합니다")
        cast = list(dict.fromkeys(cast))
        cast_problems = gamespec.cast_errors(spec, cast, ips)
        if cast_problems:
            return {"error": "cast_mismatch", "message": "출연 IP 규칙 위반: " + "; ".join(cast_problems), "errors": cast_problems}
    if spec["version"] == 2:
        # Unknown asset IDs must not become procedural substitutes for a requested IP.
        npc = spec["world"].get("npc")
        if npc is not None and "propIndex" not in npc:
            return _err("missing_npc_ip", "NPC도 준비된 IP를 사용해야 합니다. world.npc.propIndex를 지정하세요")
        if city_mode:
            npc_ip = ips.get(spec["props"][npc["propIndex"]].get("ipId"))
            if not npc_ip or npc_ip.get("kind") not in ("character", "enemy"):
                return _err("invalid_city_npc_ip", "도시 보행자는 선택한 실제 캐릭터 또는 적 NPC IP를 사용해야 합니다")
        references = [spec["player"], *spec["props"], *spec["enemies"]]
        for entity in references:
            ip = ips.get(entity.get("ipId"))
            if not ip or ip.get("cutoutAssetId") not in assets:
                return _err("missing_ip_asset", "게임의 모든 캐릭터와 소품은 이 세션의 준비된 IP를 사용해야 합니다")
        background = spec["world"].get("background")
        if background:
            ip_id = background["ipId"]
            ip = ips.get(ip_id)
            if not ip or ip.get("kind") != "prop":
                return _err("invalid_background_ip", "배경은 이 세션의 소품 IP를 별도 환경 역할로 사용해야 합니다")
            if any(e.get("ipId") == ip_id or e.get("weaponIpId") == ip_id for e in references):
                return _err("background_role_conflict", "배경 IP는 캐릭터·소품·NPC·적·무기 역할과 중복할 수 없습니다")
            field, kind = ("imageAssetId", "image") if background["mode"] == "image" else ("glbAssetId", "glb")
            asset = assets.get(ip.get(field))
            key = asset.get("key") if isinstance(asset, dict) else None
            if (not asset or asset.get("kind") != kind or asset.get("ipId") != ip_id
                    or not isinstance(key, str) or not key.startswith(f"sessions/{session['sessionId']}/")
                    or "\\" in key or ".." in key.split("/") or "://" in key):
                return _err("missing_background_asset",
                            "선택한 배경의 원본 이미지 또는 raw GLB가 이 세션에 준비되지 않았습니다. 배경을 지운 그림이나 뼈대를 넣은 모델로 "
                            "대체하지 않습니다")
            try:
                source = ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=key)
                body = source["Body"]
                try:
                    header = body.read(12)
                finally:
                    body.close()
            except Exception:
                return _err("missing_background_asset", "선택한 배경의 실제 원본 파일을 읽을 수 없습니다")
            if kind == "image":
                valid_file = (header.startswith(b"\x89PNG\r\n\x1a\n")
                              or header.startswith(b"\xff\xd8\xff")
                              or (header[:4] == b"RIFF" and header[8:12] == b"WEBP"))
            else:
                valid_file = (len(header) == 12 and header[:4] == b"glTF"
                              and int.from_bytes(header[4:8], "little") == 2
                              and 20 <= int.from_bytes(header[8:12], "little") <= 64 * 1024 * 1024
                              and (source.get("ContentLength") is None
                                   or int.from_bytes(header[8:12], "little") == source["ContentLength"]))
            if not valid_file:
                return _err("invalid_background_asset", "선택한 배경 원본은 이미지 또는 유효한 raw GLB 파일이어야 합니다")
    changed = []
    # The game this one revises: the one make_game was told (base_game_id), else the one the request's own line
    # names ("[게임 수정 gameId=…]"), when it is a game of this session: the model may leave base_game_id out
    games = {g["gameId"] for g in snap["games"]}
    base = next((b for b in (args.get("base_game_id"), gamespec.revises(source_prompt)) if isinstance(b, str) and b in games),
                None)
    if spec["version"] == 2:  # the night, dusk, rain or snow the request names
        gamespec.apply_setting(spec, source_prompt)
        # ... and a survive stage that standing still cannot clear. A revision of a game keeps the numbers the
        # user has tuned since.
        changed = gamespec.apply_survive(spec, source_prompt, bool(base))
    spec.pop("design", None)  # model output cannot claim what the user actually requested
    if design:
        spec["design"] = game_design.provenance(design)
    elif isinstance(args.get("_source_prompt"), str):
        spec["design"] = {"sourcePrompt": args["_source_prompt"], "castIpIds": cast or []}
    browser = "three" if engine == "unreal" else engine  # unreal games keep a three.js build as preview/fallback
    glb_ips = {i for i, ip in ips.items() if ip.get("glbAssetId") in assets} if browser == "three" else set()
    rig_ips = {i for i, ip in ips.items() if ip.get("riggedGlbAssetId") in assets} if browser == "three" else set()
    spec = gamespec.resolve_sprites({**spec, "engine": browser}, ips, glb_ips | rig_ips, rig_ips)
    if spec["version"] == 2:
        for entity in [spec["player"], *spec["enemies"]]:
            if entity.get("weaponIpId") and not entity.get("weaponUrl"):
                return _err("missing_weapon_asset", "선택한 무기의 3D 파일이 준비되지 않았습니다. render_3d로 무기를 먼저 준비하세요")
        for entity in spec["world"].get("entities") or []:  # a set piece without 3D stands as its cutout (not a car)
            cutout = (ips.get(entity.get("ipId")) or {}).get("cutoutAssetId") in assets
            if entity.get("kind") == "model" and not entity.get("modelUrl") and not (entity.get("spriteUrl") and cutout):
                return _err("missing_set_piece_asset", f"배경 사물 {entity.get('ipId')}의 3D 모델이 아직 없습니다. "
                                                        "그 소품 IP에 render_3d를 걸고, 끝난 뒤 게임을 만드세요")
    if browser == "three":  # a 3D game waits for its 3D: a player without it is a flat cutout panel
        waiting = _needs_3d(spec, ips, assets, _jobs(snap))
        if waiting:
            return waiting
    if not isinstance(spec.get("title"), str) or not spec["title"].strip():
        spec["title"] = _concept(session).get("title") or session["title"]
    game_id = store.new_id("gm")
    prefix = f"games/{game_id}/"
    runtime_prefix, runtime_files = (RUNTIME3D_PREFIX, RUNTIME3D_FILES) if browser == "three" else (RUNTIME_PREFIX, RUNTIME_FILES)
    if city_mode:
        runtime_files += CITY_RUNTIME_FILES
    elif (spec.get("world") or {}).get("track") is not None:
        runtime_files += TRACK_RUNTIME_FILES
    for name in runtime_files:
        _copy(ctx, runtime_prefix + name, prefix + name)
    for dst, src in _game_asset_keys(spec, ips, assets).items():
        _copy(ctx, src, prefix + dst)
    _put_json(ctx, prefix + "spec.json", spec)
    # written now too: CloudFront's SPA error mapping would answer a missing release.json with index.html
    _put_json(ctx, prefix + "release.json", {"publishedAt": None, "ad": None})
    extra = {}
    if engine == "unreal":
        extra["ue5Key"] = prefix + "ue5.json"
        _put_json(ctx, extra["ue5Key"], _ue5_template(spec, ips, assets, prefix))
    if base:
        extra["baseGameId"] = base  # a revision: the game pane's version tabs show what it was made from
    if cast:
        extra["castIpIds"] = cast
    game = store.put_game(ctx, session["sessionId"], {
        "gameId": game_id, "title": spec["title"], "genre": spec["genre"], "engine": engine, "specKey": prefix + "spec.json",
        "previewUrl": store.public_url(ctx, prefix + "index.html"), "specVersion": spec["version"],
        **extra})  # runtime fetches ./spec.json
    # changed: what the server settled in the spec (a survive stage's numbers), for the reply to state as they are.
    # noSkeleton + message: the cast whose model plays without a skeleton because the rig tool refused it.
    # attack: how the hero fights in this game as the runtime plays the written spec (authored_contract.hero_attack),
    # an authored game's only, so the reply does not guess it.
    cast_ips = [ips[i] for i in dict.fromkeys(e.get("ipId") for e in [spec["player"], *spec["enemies"]]) if i in ips]
    return {"gameId": game_id, "previewUrl": game["previewUrl"], **({"changed": changed} if changed else {}),
            **({"attack": hero_attack(spec)} if spec["version"] == 2 else {}),
            **(_no_skeleton(cast_ips, assets, _jobs(snap)) if browser == "three" else {})}


def hold_game_request(ctx, session, args):
    """The agent's word that this turn's game request waits for the hero's 3D: where that 3D is, as needs_3d tells
    it. The turn marks the request with these IPs (agent._note_hold) and the page offers it again when one is ready.
    The server cannot tell a hold from the tool events alone, hence this tool. It starts no 3D. A request already on
    hold stays the one on hold (kept) unless the call says this turn asks for another game (replace)."""
    snap, ips, assets = _lookup(ctx, session)
    ip = _pick(ips, args.get("ipId"))
    if not ip:
        return _not_found("IP", args.get("ipId"))
    jobs_by_id, name = _jobs(snap), ip.get("name") or ip["ipId"]
    if ready_3d_for_game(ip, assets, jobs_by_id):
        # a hero whose skeleton was refused is ready as it is: what to say of it rides along
        note = _no_skeleton([ip], assets, jobs_by_id).get("message")
        return _err("ready_3d", f"{name}의 3D는 이미 끝났습니다. 보류하지 말고 이번 턴에 make_game으로 게임을 만드세요."
                                + (f" {note}" if note else ""))
    row = _waiting_3d(ip, assets, jobs_by_id)
    where = (f"3D 제작 중({row['phase']} 단계, 남은 단계 {row['steps']}, 약 {row['etaMinutes']}분)" if row["state"] == "running"
             else f"3D를 시작하지 않았습니다. 이번 턴에 render_3d를 걸지 않았다면 지금 거세요(전체 보통 {waits.TOTAL})")
    kept = None if args.get("replace") is True else held_game(snap)
    if kept:
        asked = clip(kept["text"], 200)
        return {"waiting3d": [row], "kept": asked,
                "message": f"{name}: {where}. 이미 보류해 둔 게임 요청을 그대로 둡니다: \"{asked}\". 이번 메시지가 그와 다른 새 게임 "
                           f"요청일 때만 replace true로 다시 불러 바꾸세요. {HELD_GAME}"}
    return {"waiting3d": [row], "message": f"{name}: {where}. 이 게임 요청을 보류했습니다. {HELD_GAME}"}


_RESOLVED = {"spriteUrl", "modelUrl", "weaponUrl", "animUrl", "imageUrl"}


def _unresolved(obj):
    """The spec as the agent writes it: the asset URLs make_game fills in are dropped."""
    if isinstance(obj, dict):
        return {k: _unresolved(v) for k, v in obj.items() if k not in _RESOLVED}
    if isinstance(obj, list):
        return [_unresolved(v) for v in obj]
    return obj


def get_game_spec(ctx, session, args):
    game = next((g for g in store.snapshot(ctx, session["sessionId"])["games"] if g["gameId"] == args.get("gameId")), None)
    if not game:
        return _not_found("게임", args.get("gameId"))
    spec = json.loads(ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=game["specKey"])["Body"].read())
    return {"gameId": game["gameId"], "engine": game.get("engine", "three"), "spec": _unresolved(spec),
            **({"castIpIds": game["castIpIds"]} if game.get("castIpIds") else {})}


def _game_asset_keys(spec, ips, assets) -> dict:
    """{game-relative url: source S3 key} for every asset URL resolve_sprites put into the spec."""
    keys = {}
    entities = [spec["player"], *spec["props"], *spec["enemies"]]
    for e in entities:
        ip = ips.get(e.get("ipId"))
        if "spriteUrl" in e:
            keys[e["spriteUrl"]] = assets[ip["cutoutAssetId"]]["key"]
        if "modelUrl" in e:
            field = "riggedGlbAssetId" if e["modelUrl"].endswith(".rig.glb") else "glbAssetId"
            keys[e["modelUrl"]] = assets[ip.get(field) or ip["riggedGlbAssetId"]]["key"]
            if field == "riggedGlbAssetId" and ip.get("glbAssetId") in assets:
                # the raw mesh next to the rig: the runtime shows it when the rig turns out broken (game3d/world.js
                # brokenRig)
                keys[e["modelUrl"].removesuffix(".rig.glb") + ".glb"] = assets[ip["glbAssetId"]]["key"]
        if "weaponUrl" in e:
            weapon = ips[e["weaponIpId"]]
            keys[e["weaponUrl"]] = assets[weapon.get("glbAssetId") or weapon["riggedGlbAssetId"]]["key"]
    if spec.get("animUrl"):
        keys[spec["animUrl"]] = RUNTIME3D_PREFIX + "anims/ual.glb"
    background = (spec.get("world") or {}).get("background") if spec.get("version") == 2 else None
    if isinstance(background, dict):
        ip = ips[background["ipId"]]
        if background.get("mode") == "image" and "imageUrl" in background:
            keys[background["imageUrl"]] = assets[ip["imageAssetId"]]["key"]
        elif background.get("mode") == "model" and "modelUrl" in background:
            keys[background["modelUrl"]] = assets[ip["glbAssetId"]]["key"]
    for e in (spec.get("world") or {}).get("entities") or [] if spec.get("version") == 2 else []:
        if e.get("kind") == "model" and "modelUrl" in e:
            keys[e["modelUrl"]] = assets[ips[e["ipId"]]["glbAssetId"]]["key"]
        elif e.get("kind") == "model" and "spriteUrl" in e:
            keys[e["spriteUrl"]] = assets[ips[e["ipId"]]["cutoutAssetId"]]["key"]
    return keys


def _ue5_template(spec, ips, assets, prefix) -> dict:
    """ue5.json: the GameSpec plus each IP's GLB key and role. server/streams.py presigns the keys per stream.
    RPG games also cast the first unused IP with a GLB as the NPC, so the quest giver has a face."""
    roles = {}
    if spec["player"].get("modelUrl"):
        roles[spec["player"]["ipId"]] = "player"
    for prop in spec["props"]:
        if prop.get("modelUrl"):
            roles.setdefault(prop["ipId"], "prop")
    if spec["genre"].startswith("rpg-"):
        npc = next((i for i, ip in ips.items() if i not in roles and ip.get("glbAssetId") in assets), None)
        if npc:
            roles[npc] = "npc"
    urls = {e["ipId"]: e["modelUrl"] for e in [*spec["props"], spec["player"]] if e.get("modelUrl")}  # player wins
    keys = {i: prefix + urls[i] if r != "npc" else assets[ips[i]["glbAssetId"]]["key"] for i, r in roles.items()}
    return {"spec": {**spec, "engine": "unreal"},
            "ips": {i: {"role": r, "glbKey": keys[i], "name": ips[i].get("name")} for i, r in roles.items()}}


def publish_game(ctx, session, args):
    snap, _, assets = _lookup(ctx, session)
    game = _pick({g["gameId"]: g for g in snap["games"]}, args.get("gameId"))
    if not game:
        return _not_found("게임", args.get("gameId"))
    ad, ad_id = None, args.get("ad_asset_id")
    if ad_id:
        asset = _pick(assets, ad_id)
        if not asset or not asset.get("contentType", "").startswith("video/"):
            return _err("bad_args", "광고는 상태(state)에 있는 영상(트레일러, 쇼츠, 샷)이어야 합니다",
                        tr("광고로 고른 영상을 찾지 못했으니 게시 창을 닫았다가 다시 열어 골라 주세요."))
        # the notices name the 게시 dialog's own fields (web/src/components/PublishModal.tsx)
        skip = args.get("skip_after_sec")
        skip = 5 if skip is None else skip
        if isinstance(skip, bool) or not isinstance(skip, int) or not 0 <= skip <= 30:
            return _err("bad_args", "skip_after_sec는 0–30 사이 정수여야 합니다",
                        tr("건너뛰기 버튼 표시까지의 시간은 0–30초 사이로 적어 주세요."))
        every = args.get("ad_every_rounds") or 0  # 0/None = pre-roll only
        if isinstance(every, bool) or not isinstance(every, int) or not 0 <= every <= 20:
            return _err("bad_args", "ad_every_rounds는 0–20 사이 정수여야 합니다 (0 = 시작할 때만)",
                        tr("광고 다시 틀기는 0–20판 사이로 적어 주세요(0이면 시작할 때만 틀어요)."))
        ad = {"videoUrl": store.public_url(ctx, asset["key"]), "skipAfterSec": skip,
              **({"everyRounds": every} if every else {})}
    published_at, url = store.now(), store.public_url(ctx, f"games/{game['gameId']}/index.html")
    _put_json(ctx, f"games/{game['gameId']}/release.json", {"publishedAt": published_at, "ad": ad})
    store.update_game(ctx, session["sessionId"], game["gameId"], publishedUrl=url,
                      publishedAt=published_at, adAssetId=ad_id if ad else None)
    return {"publishedUrl": url}


def restore_ip_version(ctx, session, args):
    """Point the IP back at an earlier image (and the cutout made with it). Nothing is deleted. The chat gets a line
    of it, with the check that version failed, so the chat's last word on the IP names the picture now in use."""
    _, ips, assets = _lookup(ctx, session)
    ip = _pick(ips, args.get("ipId"))
    if not ip:
        return _not_found("IP", args.get("ipId"))
    image = assets.get(args.get("imageAssetId") or "")
    if not image or image.get("kind") != "image" or image.get("ipId") != ip["ipId"]:
        return _not_found("이 IP의 이미지", args.get("imageAssetId"))
    cutout = _cutout_for(assets, image)
    if not cutout:
        return _err("bad_args", "이 버전은 배경을 지운 그림이 없어 지금 그림으로 쓸 수 없습니다",
                    tr("이 버전은 배경을 지운 그림이 없어 지금 그림으로 쓸 수 없어요."))
    version = int((image.get("meta") or {}).get("version") or 1)
    store.update_ip(ctx, session["sessionId"], ip["ipId"], version=version, imageAssetId=image["assetId"],
                    cutoutAssetId=cutout["assetId"])
    check = (image.get("meta") or {}).get("check") or {}
    failed = ""
    if check.get("ok") is False:  # the picture now in use is one that failed its check
        failed = f"({': '.join(p for p in (mediagen_image.check_name(check), check.get('problem')) if p)})"
    # in the drawer's speech level and by its button's name. The check's own words are a vision model's and Korean:
    # an English line says which check it was
    if failed and i18n.lang() == "en":
        failed = f" ({i18n.label('검사 실패')})"
    store.put_message(ctx, session["sessionId"], "assistant", tr(
        "{label}: {name} v{version}. 이제 이 버전이 지금 그림이에요{failed}.", label=tool_label("restore_ip_version"),
        name=ip.get("name") or "IP", version=version, failed=failed), "done")
    return {"ipId": ip["ipId"], "version": version}


def reroll_ip_image(ctx, session, args):
    """Same request, another draw: the current image's prompt, model and references again (new seed on the box),
    saved as the next version. A text-only draw is prompted again from the IP's request with today's rules. With
    description (the agent's, for "새로 다시 그려줘 …") the draw is prompted from that look, and an edited picture
    is drawn anew from no picture, with no edit to check."""
    snap, ips, assets = _lookup(ctx, session)
    ip = _pick(ips, args.get("ipId"))
    if not ip:
        return _not_found("IP", args.get("ipId"))
    sid, jobs_by_id = session["sessionId"], _jobs(snap)
    if _image_job(ip, jobs_by_id):
        return _err("image_pending", f"{ip.get('name', '')}의 새 이미지를 이미 그리는 중입니다. 끝난 뒤에 다시 뽑을 수 있습니다.",
                    tr("{name}의 새 그림을 이미 그리는 중이니 끝난 뒤 다시 눌러 주세요.", name=ip.get("name", "")))
    if image_state(ip, jobs_by_id) == "failed":
        return _err("image_failed", f"{ip.get('name', '')}의 이미지 작업이 실패했습니다. 작업 현황에서 다시 시도해 주세요.",
                    _no_picture(ip.get("name", "")))
    meta = (assets.get(ip.get("imageAssetId") or "") or {}).get("meta") or {}
    if not meta.get("prompt") or meta.get("model") not in _image_models(ctx):
        return _err("bad_args", "이 이미지는 다시 뽑을 정보(프롬프트·모델)가 없습니다",
                    tr("이 그림은 다시 뽑을 기록이 없으니 ‘{button}’로 바꾸거나 채팅에서 새로 그려 달라고 해 주세요.",
                       button=tool_label("make_ip_variant")))
    version = _next_version(assets, ip, jobs_by_id)
    model, references, prompt = meta["model"], meta.get("references") or [], meta["prompt"]
    keep = {k: meta[k] for k in ("edit", "covered", "description") if k in meta}  # an edit is checked again
    described = _text(args, "description")  # the agent's redraw with a new look ("새로 다시 그려줘")
    if described:
        if "edit" in meta:  # never from the edited picture: a text-only draw, on the model of the IP's last such draw
            drawn = [(a.get("meta") or {}).get("model") for _, a in _versions(assets, ip["ipId"])
                     if not (a.get("meta") or {}).get("references")]
            model, references = next((m for m in reversed(drawn) if m in _image_models(ctx)), "krea"), []
        keep = {"description": described}  # what this version shows, for its shots (description_of)
    look = described or (not references and (meta.get("description") or ip.get("description")))
    if look and ip.get("kind") in IP_KINDS:
        prompt = _image_prompt(session, ip["kind"], ip.get("name") or "", look, _same_as(ip) if references else "",
                               ip.get("humanoid", True), ip.get("usage", "object"))
    if model != "stability-ultra":
        job = _queue_image(ctx, sid, ip, model, prompt, references, [], version, **keep,
                           **_promoted_eta(ctx, jobs_by_id, model))
        store.update_ip(ctx, sid, ip["ipId"], imageJobId=job["jobId"])
        return {"ipId": ip["ipId"], "version": version, **_queued(jobs_by_id, job)}
    made = _stability_image(ctx, prompt, ip.get("usage", "object"))
    made[3].update(version=version, **({"description": keep["description"]} if "description" in keep else {}))
    full, cut = _store_images(ctx, sid, ip["ipId"], made, ip.get("usage", "object"), _subject(ip), ip.get("kind") == "weapon")
    check = full["meta"].get("check") or {}
    if check.get("ok") is False:  # never over the picture the IP has (mediagen_image._flag): a version only
        note = mediagen_image.check_note(check, 1, version, int(ip.get("version") or 1))
        # the note is the user's already: 작업 현황 shows the same line (Korean in storage: the web translates it
        # there); the toast of an English page says what became of the draw
        told = note if i18n.lang() != "en" else tr("새 그림(v{version})은 검사를 통과하지 못해 버전 기록에만 두었어요.",
                                                    version=version)
        return _err("check_failed", note, told)
    store.update_ip(ctx, sid, ip["ipId"], version=version, imageAssetId=full["assetId"], cutoutAssetId=cut["assetId"])
    return {"ipId": ip["ipId"], "version": version, "imageUrl": full["url"]}


def make_skill_asset(ctx, session, args):
    """Skills tab: one genre asset = its image (create_ip_asset) and then its 3D (render_3d hunyuan3d), registered
    together: the 3D chain starts when the image job lands."""
    made = create_ip_asset(ctx, session, args)
    if "error" in made:
        return made
    mesh = render_3d(ctx, session, {"ipId": made["ipId"]})
    if "error" in mesh:  # the refusal as render_3d gave it, its sentence for the user included
        return {**made, **{k: mesh[k] for k in ("error", "message", "notice") if k in mesh}}
    return {**made, "renderJobId": mesh["jobId"], "meshJobId": mesh.get("meshJobId")}


TOOLS = {f.__name__: f for f in (set_concept, create_ip_asset, make_ip_variant, render_3d, make_video_shot,
                                 make_action_shot, animate_character, cut_trailer, make_game, get_game_spec, publish_game,
                                 restore_ip_version, reroll_ip_image, make_skill_asset)}
TOOLS["edit_video_shot"] = video_edit.edit_video_shot
TOOL_SPECS.append(game_assets.SPEC)  # an existing game takes its IPs' newest files (spec unchanged)
TOOLS["refresh_game_assets"] = game_assets.refresh_game_assets
TOOLS["hold_game_request"] = hold_game_request
UI_ONLY_TOOLS = {"restore_ip_version", "make_skill_asset"}  # card buttons; not in TOOL_SPECS, the agent never sees them
# What the studio calls each tool, in the words of the buttons that do the same on screen: a line of the chat's
# 작업 기록 starts with it (summarize), and a reply that names a tool says the same (agent.TOOL_LABELS).
_LABELS = {"set_concept": "컨셉 정하기", "create_ip_asset": "캐릭터 만들기", "make_ip_variant": "수정하기",
           "render_3d": "3D로 만들기", "make_video_shot": "영상 샷", "make_action_shot": "액션 샷",
           "animate_character": "캐릭터 애니메이션", "cut_trailer": "트레일러 만들기", "make_game": "게임 만들기",
           "get_game_spec": "게임 설계 읽기", "publish_game": "게시하기", "restore_ip_version": "이 버전 쓰기",
           "reroll_ip_image": "다시 뽑기", "make_skill_asset": "장르 스킬 IP 만들기", "edit_video_shot": "영상 수정",
           "refresh_game_assets": "게임 파일 새로 고침", "hold_game_request": "게임 요청 보류"}
_KIND_LABELS = {"prop": "소품 만들기", "weapon": "무기 만들기", "enemy": "적 만들기"}  # create_ip_asset by the IP's kind


def run_tool(ctx, session: dict, name: str, args, deadline: float = None) -> dict:
    """deadline: the caller's time.monotonic() limit (agent turn, async UI tool). Unused since no tool waits for a
    GPU image any more (they are jobs); kept so the callers need no change."""
    tool = TOOLS.get(name) if isinstance(name, str) else None
    if tool is None:
        return _err("unknown_tool", f"알 수 없는 도구입니다: {name}")
    if not isinstance(args, dict):
        return _err("bad_args", "도구 입력은 JSON 객체여야 합니다")
    return tool(ctx, session, args)


SUMMARY_CHARS = 600
# A call the agent got wrong in its own arguments or GameSpec: the refusal names arguments and fields to the model.
# The work log says it in one plain sentence; the refusal itself goes to the log (agent._loop) and to the model.
OWN_SHAPE = {"bad_args", "invalid_spec", "cast_mismatch", "cast_role_mismatch"}
ARGS_REFUSED = "입력값이 맞지 않았어요"
_BRACKETED_ID = re.compile(r"\s?\((?:ip|job|gm|ast|ses|msg)_[0-9a-f]{6,}\)")  # "테오(ip_98e2ca089d)": the name stays


def clip(text: str, limit: int = SUMMARY_CHARS) -> str:
    """At most `limit` characters, cut between words and ended with "…" when it was longer."""
    if len(text) <= limit:
        return text
    head = text[:limit - 1]
    cut = head.rsplit(" ", 1)[0] if " " in head else head
    return cut.rstrip(" ;,") + "…"


# A refusal's reason in 작업 기록 on an English page. The refusal's own text is the agent's copy and Korean; the
# line says the reason by the refusal's code, in the screen's words (a refusal with a notice says that one)
_WHY = {"needs_3d": "주인공의 3D가 아직 끝나지 않았어요", "images_pending": "그림을 아직 그리는 중이에요",
        "image_pending": "새 그림을 이미 그리는 중이에요", "image_failed": "그림을 만들지 못했어요",
        "not_found": "찾지 못했어요", "ready_3d": "3D가 이미 끝났어요", "check_failed": "그림이 검사를 통과하지 못했어요",
        "missing_weapon_asset": "무기의 3D가 아직 없어요", "missing_set_piece_asset": "배경 사물의 3D가 아직 없어요",
        "unavailable": "지금은 이 기능을 쓸 수 없어요"}
WHY_OTHER = "요청을 처리하지 못했어요"
_FIRST_EN = re.compile(r"(?<=[.)])\s+(?=[A-Z‘'])")  # the end of an English sentence


def _summarize_en(label: str, result: dict) -> str:
    code = result["error"]
    if result.get("notice") and code != "check_failed":
        why = _FIRST_EN.split(result["notice"], maxsplit=1)[0]
    elif code in OWN_SHAPE:
        why = tr(ARGS_REFUSED)
    else:
        why = tr(_WHY[code]) if code in _WHY else tr(WHY_OTHER)
    return clip(tr("{label} 실패: {why}", label=label, why=why.rstrip(".")))


def summarize(name: str, args: dict, result: dict) -> str:
    """One line for the chat's tool-event list (작업 기록), in the request's language: "<label>: <name>", or
    "<label> 실패: <why>" ("<label> failed: <why>")."""
    label = tool_label(name, args.get("kind"))
    if "error" in result and i18n.lang() == "en":
        return _summarize_en(label, result)
    if "error" in result:
        why = result.get("message") or result["error"]
        # A refusal says what happened first and what the agent is to do after it: 작업 기록 keeps the first
        # sentence, without an id in brackets. A call wrong in its own shape (OWN_SHAPE) says its notice's first
        # sentence, else the one plain sentence. A check's note is the user's as a whole.
        if result["error"] in OWN_SHAPE:
            why = re.split(r"(?<=[다요)]\.)\s", result.get("notice") or ARGS_REFUSED, maxsplit=1)[0]
        elif result["error"] != "check_failed":
            # the end of a Korean sentence, not the dot in a name such as "Dr. Kim"
            why = _BRACKETED_ID.sub("", re.split(r"(?<=[다요)]\.)\s", why, maxsplit=1)[0])
        return clip(f"{label} 실패: {why}")
    spec = args.get("spec") if isinstance(args.get("spec"), dict) else {}
    detail = args.get("title") or args.get("name") or spec.get("title") or result.get("jobId") or result.get("gameId")
    return f"{label}: {detail}" if detail else label
