"""What the agent says a job takes, and what it calls the steps of a 3D chain: the one source for the chat copy
(prompts.py, tools.py). The figures match the job cards (web/src/types.ts JOB_TYPICAL and SHOT_TYPICAL) and the box
phases the mesh lines show (server/providers/img3d.py BOOT_SEC / RELOAD_SEC / LOAD_SEC); tests hold them together."""
from server.providers.img3d import BOOT_SEC, LOAD_SEC, RELOAD_SEC, _min

# What the studio calls each step of a 3D chain, on the server and on the web alike (web/src/types.ts JOB_KIND_LABEL).
# This is the one table: tools.THREE_D_STEPS is built from it (tools imports this module, not the other way round).
STEP_LABEL = {"apose": "3D용 자세 그림", "mesh3d": "3D 모델", "rig": "움직임 뼈대", "render3d": "3D 회전 영상"}


def josa(word: str, closed: str, open_: str) -> str:
    """word with the particle its last sound takes (그림과 / 뼈대와, 모델이 / 뼈대가, 영상으로 / 모델로)."""
    last = ord(word[-1]) - 0xAC00
    final = last % 28 if 0 <= last < 11172 else 0  # a Hangul syllable's final consonant (0 = none)
    return word + (open_ if not final or (closed == "으로" and final == 8) else closed)  # ㄹ takes 로


# Each 3D step's usual minutes as its card says them ("보통 a–b분"), from its send: a mesh's include a stopped box's
# boot and load, a turntable's the wait for a farm worker (a fleet of 0–2).
THREE_D_TYPICAL = {"apose": (1, 2), "mesh3d": (2, 8), "rig": (2, 4), "render3d": (4, 7)}


def _span(lo, hi) -> str:
    return f"{lo}–{hi}분"


MESH = f"보통 {_span(*THREE_D_TYPICAL['mesh3d'])}"
# The load of either boot, which the chat cannot tell apart ahead: a stopped box started again has the models loaded
# in ~3 min, one launched new takes ~5 min. The mesh's own line says which (img3d._load_sec).
BOX = f"GPU 서버가 꺼져 있으면 켜는 데 ~{_min(BOOT_SEC)}분, 준비에 ~{_span(_min(RELOAD_SEC), _min(LOAD_SEC))} 포함"


def chain_total(kinds) -> str:
    """A 3D chain of these steps, their cards added up."""
    return _span(sum(THREE_D_TYPICAL[k][0] for k in kinds), sum(THREE_D_TYPICAL[k][1] for k in kinds))


# The whole chain of a character or a humanoid enemy (A-pose, mesh, rig, turntable), the steps one after another
TOTAL = chain_total(THREE_D_TYPICAL)
# ... and of any other IP, which has no A-pose and no rig
UNRIGGED = ("mesh3d", "render3d")
TOTAL_UNRIGGED = chain_total(UNRIGGED)
# A render_3d request, as the agent tells it
RENDER_3D = (f"{STEP_LABEL['mesh3d']} {MESH}({BOX}), {STEP_LABEL['render3d']}까지 전체 보통 {TOTAL_UNRIGGED}, "
             f"{josa(STEP_LABEL['apose'], '과', '와')} {josa(STEP_LABEL['rig'], '이', '가')} 붙는 캐릭터·사람형 적은 {TOTAL}")
# A background's 3D (a relief of the scene picture) is one render3d job on the same farm: its card says that step's time
RELIEF = f"보통 {_span(*THREE_D_TYPICAL['render3d'])}"

# What the other job cards say (web/src/types.ts JOB_TYPICAL image and trailer, SHOT_TYPICAL by video model). An
# image's span covers a 20–60 s draw on the shared box up to ~3 min behind a model swap or a queue.
CARD_TYPICAL = {"image": "보통 20초–3분", "trailer": "보통 1–3분", "shot": "보통 5–10분"}
SHOT_TYPICAL = {"ltx": "보통 5–7분", "minimax-h3": "보통 4–5분", "kandinsky-6-0-video-pro": "보통 22–27분",
                "wan-animate": "보통 1–5분"}
IMAGE = CARD_TYPICAL["image"]
# A stopped video model's own boot (MiniMax H3 ~2 min, Kandinsky ~4 min with its model load; LTX is always up)
VIDEO_BOOT = "정지된 모델은 부팅 ~2–4분 추가"

# A promoted model's GPU box (behind the videogen MCP) is stopped until its first request and boots in ~10 min, then
# draws like the shared box. The boot is in the ETA only when the box is not up (tools._box_running asks EC2); when
# EC2 does not say, the reply tells both ends.
PROMOTED_BOOT_MIN = 10

# A trailer's first full-screen ad on air (server/live.py): the ad service transcodes a trailer it has not sent before
# (live.TRANSCODE_SEC). Until then an ad round shows corner trailers.
TRAILER_PREP = "1–2분"

# A cloud stream's start (GameLift Streams, the web stream group), in seconds (shortest, longest). warm: a host is
# already held and a session connects on it. cold: the group allocates a host first. live.standby_status hands these
# to the console as startSec.
CLOUD_START_SEC = {"warm": (10, 20), "cold": (240, 360)}
CLOUD_WARM = "{}–{}초".format(*CLOUD_START_SEC["warm"])
CLOUD_COLD = _span(*(sec // 60 for sec in CLOUD_START_SEC["cold"]))
CLOUD_START = f"처음 켤 때 {CLOUD_COLD}, 서버가 켜져 있으면 {CLOUD_WARM}"


def span_sec(lo: float, hi: float) -> str:
    """Two waits in seconds as whole minutes, "a–b분"."""
    return _span(round(lo / 60), round(hi / 60))


def promoted_image_eta(queued: int = 1, image_sec: int = 30, running: bool = False) -> int:
    """Minutes until a promoted model's picture lands: the draws queued on its box (one ~30 s draw when the caller
    knows no queue), after the box's boot unless it is already running."""
    return (0 if running else PROMOTED_BOOT_MIN) + max(1, -(-queued * image_sec // 60))


def promoted_image_wait(label: str, queued: int, image_sec: int, running) -> str:
    """The sentence of a promoted model's wait, for the tool's message: running True = its box is up, False = stopped
    or still coming up, None = unknown (both ends are told)."""
    warm, cold = promoted_image_eta(queued, image_sec, True), promoted_image_eta(queued, image_sec)
    boot = f"켜는 시간(~{PROMOTED_BOOT_MIN}분)을 포함해 약 {cold}분 뒤"
    if running:
        return f"{label}의 GPU 서버가 켜져 있어 약 {warm}분 뒤 왼쪽에 나타납니다."
    if running is None:
        return f"{label}의 GPU 서버가 켜져 있으면 약 {warm}분, 정지돼 있으면 {boot} 왼쪽에 나타납니다."
    return f"{label}의 GPU 서버가 정지돼 있어 {boot} 왼쪽에 나타납니다."
