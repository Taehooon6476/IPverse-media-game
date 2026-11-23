"""Video shots on the account's self-hosted GPU boxes through the mediagen MCP proxy (see mcp_client): image/text →
video on LTX-2.5, MiniMax H3 (also first + last frame) and every model promoted through the MCP's Video Model Scout
(video_start), Wan 2.2 Animate, and video-to-video edits of an existing shot (LTX restyle, LTX IC-LoRA tasks, LTX
inpaint, Wan VACE restyle). A stopped box boots on its first start call (~1.5-4 min with the model load); every
model has its own server-side queue. Which models, tools and LTX tasks exist is read from the MCP itself
(catalog(), cached). The MCP has no cancel tool: a stopped job keeps running on its box, so a retry takes that run
over (jobs.retry_job).

A restyle follows the MCP's own recipe: FLUX.2 klein first repaints the clip's first frame in the new style (style
words only), and that anchor goes in as reference_image_url. The anchor only conditions frame 0 and its pull fades,
so a longer LTX clip is cut into ~5 s pieces, each anchored on klein's repaint of its own first frame (same words,
same seed), all started at once; neighbouring pieces share SEAM frames, the join dissolves across them and the later
piece's colours are matched to the earlier one's. A piece also starts where the picture leaves what its anchor
shows. An inpaint longer than ~15 s is cut too, without anchors, and so is an upscale bigger than one LTX pass (on
the frame, so the result has exactly the source's frames). A staged edit keeps its state in externalId (STAGED +
JSON): the anchors' image jobs, then the started edit jobs. A restyle or v2v asks its box for a size on the box's
grid and comes back at the source's own size (an upscale: twice it). An upscale, a deblur and a decompress must
hand back the source's own picture (KEEP): each piece is measured against its source frames, and pieces the box
drew again are not delivered.
"""
from __future__ import annotations
import json
import math
import os
import random
import re
import subprocess
import tempfile
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

from server import store
from server.providers import ffmpeg, mcp_client
from server.providers.base import s3_key_for

DIMS = {  # (width, height) per aspect; promoted models (video_start) take no dims
    "ltx": {"16:9": (1280, 704), "9:16": (704, 1280)},
    "minimax-h3": {"16:9": (1344, 768), "9:16": (768, 1344)},
    "wan-animate": {"16:9": (832, 480), "9:16": (480, 832)},
}
# One LTX pass makes up to 20 s (verified at 960x512 with audio, ~6 min); past 8 s only at this size.
# ponytail: 1280x704 x 20 s was not tried; raise LTX_FULL_RES_MAX_SEC if the box turns out to fit it.
LTX_FULL_RES_MAX_SEC = 8
LTX_LONG_DIMS = {"16:9": (960, 512), "9:16": (512, 960)}
# The built-in models have their own tools; every other list_video_models row is a promoted model: video_start(model=id)
START_TOOL = {"ltx": "ltx_start_video", "minimax-h3": "minimax_h3_start_video", "wan-animate": "wan_animate_start"}
STATUS_TOOL = {"ltx": "ltx_get_status", "minimax-h3": "minimax_h3_get_status", "wan-animate": "wan_animate_get_status"}
# edit_video_shot: (edit, model) → the MCP start tool. ltx_get_status polls every LTX job (t2v/i2v, v2v, restyle).
EDIT_TOOL = {("restyle", "ltx"): "ltx_restyle_start", ("restyle", "wan-animate"): "wan_restyle_start",
             ("v2v", "ltx"): "ltx_v2v_start", ("inpaint", "ltx"): "ltx_inpaint_start"}
UNUSABLE = ("disabled", "not_provisioned", "load_failed")  # list_video_models: never call these rows
IMAGE_KINDS = {"t2i", "i2i"}  # promoted image models (server/agents.py) are listed by list_image_models instead
# Edit tools that take a clip in pieces of about this many seconds (MCP docs): the restyle's anchor fades after ~5 s
# (Wan windows the clip itself), the inpaint wants each call under ~15 s of source. +10%: a 5.04 s clip is one piece.
CHUNK_SEC = {"ltx_restyle_start": 5, "ltx_inpaint_start": 15}
CHUNK_SLACK = 1.1
# Minutes on an idle box: klein's anchors ~2 (all started at once, drawn together), then ~6 per ~4-5 s LTX piece,
# one after another; every LTX job already on the box goes first, ~6 min each.
ANCHOR_MIN, PIECE_MIN, LTX_CLIP_MIN = 2, 6, 6
# A 2x upscale piece (one LTX pass, 65 frames at 1408x2560) on an idle box takes ~8.6 min; a same-size v2v ~6 min.
UPSCALE_PIECE_MIN = 9
# Where a restyle's anchor stops covering its piece: when the picture leaves what the piece's first frame shows (an
# i2v shot that opens on its start image, then dissolves into the scene), the rest comes back photoreal. So a piece
# also starts there: colour-histogram distance (0-1, 4x4x4 RGB bins on 64x36 frames) from the piece's first frame
# past SCENE_LEAVE (a scene change measures ~0.8, camera and pose moves in one scene at most 0.44). The new piece
# starts once the picture settles (under SCENE_SETTLE over the next 8 frames) on the 8-frame grid, and never under
# a second from another start.
SCENE_LEAVE, SCENE_SETTLE = 0.6, 0.1
THUMB = (64, 36)
# A later piece's colours are matched to the piece before over the frames they share (the same source frames, so the
# two should look alike there): per-channel gain and offset, the gain kept within this range.
GRADE_GAIN = (0.6, 1.6)
# Frames two neighbouring restyle pieces share: one LTX latent step (8 frames) and its boundary frame. The join
# dissolves over them, so the two pieces' slightly different repaints meet without a cut.
SEAM = 9
ANCHOR_MODEL = "klein9"  # FLUX.2 klein 9B: the image MCP model that repaints a picture from a reference
# The change leads: klein returns the reference unchanged under a long "keep everything" clause. {style} is the
# style words alone: with scene words in, klein paints a scene the frame does not have.
ANCHOR_PROMPT = ("{style}. Repaint the reference image in this art style, clearly visible over the whole picture. "
                 "Keep its exact composition, framing, background, pose and characters. No text.")
# The restyle boxes snap the asked size down to their grid (LTX union-control: 64 px x its reference downscale 2;
# Wan: 16 px) and center-crop the source to that shape. So ask for the box's usual short side and the long side on
# its grid nearest the shot's shape; the result is fitted back to the source's own size (_fit).
RESTYLE_GRID = {"ltx_restyle_start": (128, 640), "wan_restyle_start": (16, 480)}  # tool → (grid, short side)
SHOT_SIZE = {"16:9": (1280, 704), "9:16": (704, 1280)}  # LTX's; the other models' shots are within 5% of its shape
# Depth control at full strength holds the source's layout and motion (canny gives a flat edge-map look, and a lower
# strength lets the model redraw them); the style comes from the anchor and the prompt. The MCP's own guidance.
RESTYLE_SETTINGS = {"control": "depth", "strength": 1.0}
# The style leads the restyle prompt and closes it: without that a long clip drifts back to photoreal.
RESTYLE_PROMPT = "{prompt}. The whole clip stays {style}, every frame."
# ltx_v2v_start: with no size the box works from a half-size reference and snaps to its grid, so the result is a
# regenerated clip of another size. So ask for the target size (an upscale: twice the source) rounded up to the
# box's 128 px grid, and fit the result to it exactly.
V2V_GRID = 128
UPSCALE = "upscale"
# ltx_v2v_start draws the clip again: an upscale can change a face or an outfit between pieces. So the tasks that
# must hand back the source's own picture (KEEP) are anchored on each piece's own first source frame and measured
# (_off_source), and a result past the limits is not delivered: an upscale is the source enlarged by ffmpeg
# (PLAIN_2X); a deblur or a decompress fails saying why, since no ffmpeg filter takes a blur or a compression loss
# back out.
KEEP = (UPSCALE, "deblur", "decompress")
PLAIN_2X = "scale=iw*2:ih*2:flags=lanczos,setsar=1"
# The measure (_off_source), for the worst frame of a piece as the box made it: the mean |RGB| difference from its
# source frame at 320 px, over the frame and over its worst block (a head drawn again moves the frame's mean
# little). It is read two ways:
# - through the box's crop: a size off the box's grid is asked for rounded up (v2v_dims) and the box crops the
#   source to that shape, so the source is fitted to the box's size the same way before comparing.
# - against the frame's own contrast: a redraw moves a frame by a share of its contrast, so each frame's figures
#   are scaled to the spread the limits were set at (KEEP_SPREAD: the standard deviation of the source frame's
#   levels at 80x44), and a frame flatter than KEEP_FLAT (a fade) is read as that flat.
# Read so, a clip the box drew again measures 12+ (mean) and 47+ (worst block); the same picture (a plain 2x, the
# box's own anchored frame 0, a deblur of a soft shot) at most 6.8 and 28. An upscale adds only detail finer than a
# 320 px frame shows, so its worst block has the tighter limit.
# ponytail: a true deblur or decompress of a badly blurred or compressed dark shot reads 9-21 and is refused too.
KEEP_MEAN, KEEP_BLOCK, KEEP_BLOCK_UPSCALE = 8, 32, 16
KEEP_GRID = (320, 176, 16)  # the measured frame's long and short side, and the block, in px
KEEP_SPREAD, KEEP_FLAT = 76, 19  # the spread the limits were set at, and the least a frame is read as having
REDRAWN = "원본 보존 검사 실패"  # starts the job's line when the box drew a KEEP task's clip again
# One LTX pass verified on the box: 20 s at 960x512 (481 frames). A bigger v2v runs in pieces of at most this many
# pixel-frames. ponytail: a 2x upscale of a 704p shot runs in ~2.5 s pieces until a live run says more fits.
LTX_PASS_PIXEL_FRAMES = 960 * 512 * 481
FPS = 24  # LTX's frame rate: a restyle piece is cut at it, so the box returns it frame for frame
STAGED = "edit:"  # externalId of a staged edit: STAGED + JSON
STARTING = "영상 편집 시작 중"
START_STALE_SEC = 300  # a poll that claimed starting the pieces went silent this long: it died
# EC2 had no GPU of the box's type in its zone, so the MCP could not start a stopped box (jobs.py retries it later)
CAPACITY = ("insufficientinstancecapacity", "insufficient capacity")
# the MCP's boot phases (its _boot_and_submit) as the user reads them; a box boots in ~1.5-4 min with its model load
PHASES = {
    "starting_instance": "정지된 GPU 서버 켜는 중 (~2분)", "instance_stopped": "정지된 GPU 서버 켜는 중 (~2분)",
    "instance_pending": "GPU 서버 부팅 중 (~2분)", "instance_stopping": "GPU 서버가 꺼지는 중, 끝나면 다시 켬",
    "instance_running": "GPU 서버 시작 중", "model_loading": "GPU 서버에 모델 불러오는 중 (~1–3분)",
    "waiting_for_model": "GPU 서버에 모델 불러오는 중 (~1–3분)",
    "queued_on_server": "GPU 대기열에서 순서 기다리는 중",
    # the box's own status words, which would otherwise reach the card raw
    "queued": "GPU 대기열에서 순서 기다리는 중", "pending": "GPU 대기열에서 순서 기다리는 중",
    "submitted": "GPU 서버에 제출됨", "starting": "GPU 서버 시작 중", "loading": "GPU 서버에 모델 불러오는 중 (~1–3분)",
    "denoising": "영상 생성 중", "running": "영상 생성 중", "generating": "영상 생성 중", "sampling": "영상 생성 중",
    "decoding": "영상 마무리 중 (디코딩)", "encoding": "영상 마무리 중 (인코딩)", "uploading": "결과 영상 올리는 중",
    "postprocessing": "영상 마무리 중",
}
WORKING = "영상 생성 중"  # a phase the box names in English that no line above maps


def phase_text(phase) -> str:
    """The card's Korean for one of the video box's phases: never its raw English word."""
    if not phase:
        return WORKING
    text = str(phase)
    return PHASES.get(text) or PHASES.get(text.lower()) or (text if re.search(r"[가-힣]", text) else WORKING)


def call_tool(ctx, tool: str, arguments: dict) -> dict:
    return mcp_client.call_tool(ctx, mcp_client.VIDEO, tool, arguments)


def start_tool(model: str) -> str:
    return START_TOOL.get(model, "video_start")


def status_tool(inp: dict) -> str:
    model = inp.get("model", "ltx")
    if inp.get("edit"):
        return "wan_restyle_get_status" if model == "wan-animate" else "ltx_get_status"
    return STATUS_TOOL.get(model, "video_get_status")


# ── What the MCP offers: its tools/list, list_video_models and ltx_list_tasks, cached per container ──

CATALOG_TTL_SEC = 300  # a scout promotion or a box state change shows up within 5 minutes
CATALOG_RETRY_SEC = 60  # after a failed read the last good answer (or the defaults) is used this long
CATALOG_WAIT_SEC = 8  # the three reads run in parallel (~2 s warm, ~9 s on a cold proxy); GET /connections has ~30 s
# The MCP's listing, used only while it cannot be read.
DEFAULT_CATALOG = {
    "models": [
        {"id": "ltx", "label": "LTX 22B (2.5 + 2.3, all IC-LoRAs)", "kinds": ["i2v", "t2v", "v2v", "restyle"], "status": "ready",
         "promoted": False},
        {"id": "wan-animate", "label": "Wan2.2-Animate-14B + Wan2.1-VACE-14B", "kinds": ["animate", "restyle"], "status": "ready",
         "promoted": False},
        {"id": "minimax-h3", "label": "MiniMax H3 (Hailuo 3.0)", "kinds": ["t2v", "i2v"], "status": "stopped", "promoted": False},
        {"id": "kandinsky-6-0-video-pro", "label": "Kandinsky 6.0 Video Pro", "kinds": ["t2v", "i2v"], "status": "stopped",
         "promoted": True},
    ],
    "tools": {"ltx_start_video": ["prompt", "image_url", "seconds", "width", "height", "seed"],
              "minimax_h3_start_video": ["prompt", "image_url", "last_image_url", "seconds", "width", "height", "seed"],
              "video_start": ["model", "prompt", "image_url", "seconds", "seed"],
              "wan_animate_start": ["reference_image_url", "driving_video_url", "prompt", "seconds", "width", "height", "seed"],
              "ltx_restyle_start": ["video_url", "prompt", "control", "seconds", "strength", "reference_image_url"],
              "wan_restyle_start": ["video_url", "prompt", "seconds", "control", "strength", "width", "height",
                                    "reference_image_url"],
              "ltx_v2v_start": ["task", "video_url", "prompt", "seconds", "strength", "reference_image_url"],
              "ltx_inpaint_start": ["video_url", "prompt", "task", "keep_level", "mode", "seconds"]},
    "tasks": [{"task": t, "description": ""} for t in ("upscale", "deblur", "decompress", "colorize", "day_to_night",
                                                         "clean_plate", "water", "relight", "in_outpainting", "hdr")],
}
_catalog: dict = {}


def catalog(ctx, fresh: bool = False) -> dict:
    """{models: [{id, label, kinds, status, promoted}], tools: {name: [param, ...]}, tasks: [{task, description}],
    live: read from the MCP just now or within CATALOG_TTL_SEC}."""
    now = time.time()
    if _catalog and not fresh and now < _catalog["until"]:
        return _catalog
    pool = ThreadPoolExecutor(max_workers=3)
    try:
        listed = pool.submit(mcp_client._post, mcp_client.VIDEO.url, {"jsonrpc": "2.0", "id": 1, "method": "tools/list",
                                                                      "params": {}}, mcp_client._api_key(ctx, mcp_client.VIDEO.key_param))
        models = pool.submit(call_tool, ctx, "list_video_models", {})
        tasks = pool.submit(call_tool, ctx, "ltx_list_tasks", {})
        deadline = time.monotonic() + CATALOG_WAIT_SEC

        def result(future):
            return future.result(timeout=max(0.1, deadline - time.monotonic()))
        tools = (result(listed).get("result") or {}).get("tools") or []
        rows = result(models).get("models") or []
        try:
            task_rows = result(tasks).get("tasks") or []
        except Exception:  # noqa: BLE001 — the task list is optional: the last good (or default) one stays
            task_rows = (_catalog or DEFAULT_CATALOG)["tasks"]
        if not tools or not rows:
            raise RuntimeError("영상 MCP가 도구나 모델 목록을 비워 보냈습니다")
        fresh_catalog = {
            "models": [{"id": m["id"], "label": m.get("label") or m["id"], "kinds": list(m.get("kinds") or []),
                        "status": m.get("status") or "unknown", "promoted": bool(m.get("promoted"))}
                       for m in rows if isinstance(m, dict) and m.get("id")
                       # a promoted IMAGE model's box carries the same registry tags: it belongs to the image list
                       and not (m.get("kinds") and set(m["kinds"]) <= IMAGE_KINDS)],
            "tools": {t["name"]: sorted(((t.get("inputSchema") or {}).get("properties") or {}).keys())
                      for t in tools if isinstance(t, dict) and t.get("name")},
            "tasks": [{"task": t["task"], "description": t.get("description", "")} for t in task_rows
                      if isinstance(t, dict) and t.get("task")],
            "live": True, "until": now + CATALOG_TTL_SEC}
    except Exception:  # noqa: BLE001 — a down or slow MCP must not break the chat: keep what was known
        traceback.print_exc()
        fresh_catalog = {**DEFAULT_CATALOG, **{k: v for k, v in _catalog.items() if k in ("models", "tools", "tasks")},
                         "live": False, "until": now + CATALOG_RETRY_SEC}
    finally:
        pool.shutdown(wait=False)  # a call still hanging past CATALOG_WAIT_SEC finishes (and is dropped) on its own
    _catalog.clear()
    _catalog.update(fresh_catalog)
    return _catalog


def shot_model_error(ctx, model, kind: str, aspect: str = "16:9"):
    """None if `model` makes `kind` ("i2v" image → video | "t2v" text → video) shots in `aspect`, else why not
    (Korean). A model whose start tool takes no height (video_start: promoted models) makes its own landscape size,
    so 9:16 is refused for it."""
    cat = catalog(ctx)
    usable = [m for m in cat["models"] if kind in m["kinds"] and m["status"] not in UNUSABLE
              and start_tool(m["id"]) in cat["tools"]]
    if aspect == "9:16" and any(m["id"] == model for m in usable) and not _sized(cat, model):
        label = next(m["label"] for m in usable if m["id"] == model)
        vertical = [m["id"] for m in usable if _sized(cat, m["id"])]
        return (f"{label}은(는) 크기를 받지 않아 세로(9:16)로 만들지 못하고 가로 영상만 나옵니다. 9:16 샷은 model을 "
                f"{'|'.join(vertical)} 중에서 고르거나, 이 모델로 16:9 샷을 만드세요")
    if any(m["id"] == model for m in usable):
        return None
    row = next((m for m in cat["models"] if m["id"] == model), None)
    what = "텍스트만으로" if kind == "t2v" else "이미지로"
    why = (f"{row['label']}은(는) 지금 쓸 수 없는 상태입니다({row['status']})" if row and row["status"] in UNUSABLE
           else f"{row['label']}은(는) {what} 영상을 만들지 않습니다" if row else f"영상 MCP에 없는 모델입니다: {model}")
    return f"{why}. model은 {'|'.join(m['id'] for m in usable)} 중 하나여야 합니다"


def _sized(cat: dict, model: str) -> bool:
    """The model's start tool takes a width and height (its shots can be vertical)."""
    return model in DIMS and "height" in cat["tools"].get(start_tool(model), ())


def takes_last_frame(ctx, model: str) -> bool:
    """The model's start tool accepts a last frame (MiniMax H3: first + last frame interpolation)."""
    return "last_image_url" in catalog(ctx)["tools"].get(start_tool(model), ())


def _shot_key(ctx, session_id: str, job_id: str) -> str:
    snap = store.snapshot(ctx, session_id)
    job = next((j for j in snap["jobs"] if j["jobId"] == job_id), None)
    assets = {a["assetId"]: a for a in snap["assets"]}
    for asset_id in (job or {}).get("outputs", []):
        if assets.get(asset_id, {}).get("kind") == "shot":
            return assets[asset_id]["key"]
    raise RuntimeError("원본 영상 샷이 없습니다")


def _edit_tool(inp: dict) -> str:
    model = inp.get("model", "ltx")
    tool = EDIT_TOOL.get((inp["edit"], model))
    if not tool:
        raise RuntimeError(f"지원하지 않는 영상 편집입니다: {inp['edit']} · {model}")
    return tool


def _edit_args(ctx, inp: dict, video_key: str, anchor: str = None, stage: dict = None) -> dict:
    """edit_video_shot's job → the start tool's arguments for one clip (the source shot's mp4, or one piece of it) as
    video_url. Length defaults to that clip; a staged edit's stage brings the v2v size and the restyle seed."""
    stage = stage or {}
    args = {"video_url": mcp_client.public_input_url(ctx, video_key), "prompt": inp.get("prompt", "")}
    if inp["edit"] == "v2v" or (inp["edit"] == "inpaint" and inp.get("task")):
        args["task"] = inp["task"]
    if inp["edit"] == "inpaint" and inp.get("keep_level") is not None:
        args["keep_level"] = inp["keep_level"]
    tool = _edit_tool(inp)
    if tool in RESTYLE_GRID:
        args["prompt"] = restyle_prompt(inp)
        args["width"], args["height"] = restyle_dims(tool, inp.get("aspect_ratio", "16:9"))
        args.update(RESTYLE_SETTINGS)
    if stage.get("ask"):  # a v2v: the size on the box's grid, the source fully conditioning it
        args["width"], args["height"] = stage["ask"]
        args["strength"] = 1.0
    if stage.get("seed"):  # every piece of one restyle draws from the same noise
        args["seed"] = stage["seed"]
    if anchor:
        args["reference_image_url"] = anchor
    return args


def restyle_prompt(inp: dict) -> str:
    """The restyle prompt: the agent's (the style, then a short scene), led by the style if it is not, and closed by
    it again (RESTYLE_PROMPT)."""
    prompt, style = inp.get("prompt", "").strip().rstrip(". "), (inp.get("style") or "").strip().rstrip(". ")
    if not style:  # jobs made before `style` existed
        return inp.get("prompt", "")
    if style.split(",")[0].strip().lower() not in prompt.lower():
        prompt = f"{style}, {prompt}" if prompt else style
    return RESTYLE_PROMPT.format(prompt=prompt, style=style)


def v2v_dims(size: tuple, scale: int) -> tuple:
    """(width, height) to ask ltx_v2v_start for: `scale` times the source, rounded up to the box's grid (the result
    is fitted back to exactly scale x the source)."""
    return tuple(max(V2V_GRID, math.ceil(v * scale / V2V_GRID) * V2V_GRID) for v in size)


def v2v_scale(inp: dict) -> int:
    return 2 if UPSCALE in (inp.get("task") or "").split("+") else 1


def keeps(inp: dict) -> bool:
    """A v2v whose every task hands back the source's own picture (KEEP)."""
    return inp.get("edit") == "v2v" and all(task in KEEP for task in (inp.get("task") or "").split("+"))


def restyle_dims(tool: str, aspect: str) -> tuple:
    """(width, height) to ask a restyle box for: its usual short side, and the long side on its grid nearest the
    shot's shape."""
    grid, short = RESTYLE_GRID[tool]
    w, h = SHOT_SIZE.get(aspect, SHOT_SIZE["16:9"])
    long = max(grid, round(short * max(w, h) / min(w, h) / grid) * grid)
    return (long, short) if w >= h else (short, long)


def _start(ctx, tool: str, args: dict) -> str:
    out = call_tool(ctx, tool, args)
    if out.get("status") == "FAILED" or not out.get("job_id"):
        raise RuntimeError(f"mediagen {tool}: {out.get('error') or out}"[:300])
    return out["job_id"]


def _anchored(ctx, inp: dict, tool: str) -> bool:
    return (inp["edit"] == "restyle" and inp.get("aspect_ratio", "16:9") == "16:9"
            and "reference_image_url" in catalog(ctx)["tools"].get(tool, ()))


def restyle_minutes(pieces: int) -> int:
    """What an anchored LTX restyle in `pieces` pieces usually takes on idle boxes: the anchors together, then the
    pieces one after another."""
    return ANCHOR_MIN + PIECE_MIN * pieces


def v2v_piece_minutes(inp: dict) -> int:
    """What one ltx_v2v_start piece usually takes on an idle box: a 2x upscale pass ~9 min, a same-size task ~6."""
    return UPSCALE_PIECE_MIN if v2v_scale(inp) == 2 else LTX_CLIP_MIN


def restyle_pieces(ctx, inp: dict, src_key=None) -> int:
    """How many pieces an anchored restyle runs in: _prepare's own plan (plan_restyle, scene changes included) when
    the source shot is in the bucket, so the chat, the job's etaMinutes and the card's line say one figure; else by
    its length alone (plan_pieces)."""
    limit = CHUNK_SEC["ltx_restyle_start"]
    if src_key:
        try:
            with tempfile.TemporaryDirectory() as tmp:
                src = os.path.join(tmp, "src.mp4")
                ctx.s3.download_file(ctx.assets_bucket, src_key, src)
                thumbs = _thumbs(ctx.ffmpeg_bin, src)
            if thumbs:
                return len(plan_restyle(len(thumbs), scene_cuts(thumbs), limit))
        except Exception:  # noqa: BLE001  the estimate only: the job plans again when it starts
            pass
    return len(plan_pieces(float(inp.get("seconds") or 0), limit))


def edit_minutes(ctx, inp: dict, ahead: int = 0, src_key=None):
    """edit_video_shot's etaMinutes, from the source's length (and, for a v2v, its shot size): an anchored LTX
    restyle's anchors and pieces (restyle_pieces: read off the source at `src_key` when given), or a v2v's pieces one
    after another, and ~6 min for each of the `ahead` LTX jobs that are on the box before it. None for the other
    edits (the web's per-model figure)."""
    tool = _edit_tool(inp)
    seconds = float(inp.get("seconds") or 0)
    if tool == "ltx_v2v_start":
        ask = v2v_dims(SHOT_SIZE.get(inp.get("aspect_ratio", "16:9"), SHOT_SIZE["16:9"]), v2v_scale(inp))
        return v2v_piece_minutes(inp) * len(plan_v2v(round(seconds * FPS) + 1, ask)) + LTX_CLIP_MIN * ahead
    if tool != "ltx_restyle_start" or not _anchored(ctx, inp, tool):
        return None
    return restyle_minutes(restyle_pieces(ctx, inp, src_key)) + LTX_CLIP_MIN * ahead


def on_ltx_box(job: dict) -> bool:
    """The job runs on the LTX box (an LTX shot or any LTX edit; Wan, MiniMax H3 and promoted models have their own)."""
    return job.get("provider") == "mediagen_video" and (job.get("input") or {}).get("model", "ltx") == "ltx"


def plan_pieces(seconds: float, limit: float) -> list:
    """[(start, length)]: equal pieces of at most ~limit seconds; the last one runs to the end (length None)."""
    n = max(1, math.ceil(seconds / (limit * CHUNK_SLACK)))
    step = round(seconds / n, 3)
    return [(round(i * step, 3), None if i == n - 1 else step) for i in range(n)]


def plan_frames(frames: int, pieces: int, shared: int = SEAM) -> list:
    """[(first frame, frame count)]: pieces whose neighbours share `shared` frames (8j+1: each starts that many
    frames before the previous one ends). All but the last are 8k+1 frames long, the clip length LTX makes, so each
    comes back frame for frame; the last runs to the end (count None)."""
    back = (shared - 1) // 8  # latent steps two neighbours share
    steps = (frames - 1) // 8 + back * (pieces - 1)
    out, first = [], 0
    for i in range(pieces):
        k = steps // pieces + (i < steps % pieces)
        out.append((first, None if i == pieces - 1 else 8 * k + 1))
        first += 8 * (k - back)
    return out


def plan_restyle(frames: int, cuts: list, limit: float) -> list:
    """[(first frame, frame count)] for an anchored restyle: every scene (between `cuts`, on the 8-frame grid) in
    pieces of ~limit seconds (plan_frames); a scene's last piece runs SEAM frames into the next scene's first, so the
    join dissolves there too. Count None: the last piece runs to the end."""
    bounds, out = [0, *cuts, frames], []
    for a, b in zip(bounds, bounds[1:]):
        last = b == frames
        n = max(1, math.ceil((b - a) / FPS / (limit * CHUNK_SLACK)))
        out += [(a + first, count) for first, count in plan_frames(b - a + (0 if last else 1), n)]
        if not last:
            out[-1] = (out[-1][0], b - out[-1][0] + SEAM)
    return out


def plan_v2v(frames: int, ask) -> list:
    """[(first frame, frame count)]: as few pieces as keep each under one LTX pass at `ask` (LTX_PASS_PIXEL_FRAMES),
    neighbours sharing SEAM frames (plan_frames) so the join dissolves and is colour-matched there like a restyle's
    (each piece is generated on its own). All but the last are 8k+1 frames, the length LTX makes, so the box adds
    none. Count None: to the end."""
    most = LTX_PASS_PIXEL_FRAMES / (ask[0] * ask[1])
    if frames <= most:
        return [(0, None)]
    pieces = 2
    while True:
        plan = plan_frames(frames, pieces)
        if all((count or frames - first) <= most for first, count in plan) or pieces >= frames // SEAM:
            return plan
        pieces += 1


def _thumbs(ffmpeg_bin: str, path: str) -> list:
    """A clip's frames on the 24 fps clock as small RGB pictures (THUMB, rgb24 bytes each): for counting frames,
    finding where the picture changes, and matching colours."""
    w, h = THUMB
    done = subprocess.run([ffmpeg_bin, "-v", "error", "-i", path, "-vf", f"fps={FPS},scale={w}:{h},format=rgb24",
                           "-f", "rawvideo", "-"], capture_output=True)
    if done.returncode:
        raise RuntimeError(f"ffmpeg: {done.stderr.decode('utf-8', 'replace').strip()[-300:]}")
    n = w * h * 3
    return [done.stdout[i:i + n] for i in range(0, len(done.stdout) - n + 1, n)]


def _hist(thumb: bytes) -> list:
    h = [0] * 64
    for i in range(0, len(thumb), 3):
        h[(thumb[i] >> 6) * 16 + (thumb[i + 1] >> 6) * 4 + (thumb[i + 2] >> 6)] += 1
    return h


def _hist_off(a: list, b: list) -> float:
    """How much of the picture's colour two frames do not share: 0 the same, 1 nothing alike."""
    return sum(abs(x - y) for x, y in zip(a, b)) / (2 * sum(a))


def scene_cuts(thumbs: list) -> list:
    """Frames (on the 8-frame grid) where a restyle piece must start because the picture has left what the current
    piece's first frame shows (SCENE_LEAVE), once it settles (SCENE_SETTLE); at least a second from another start
    and from the end."""
    hists = [_hist(t) for t in thumbs]
    n, cuts, anchor, i = len(hists), [], 0, 1
    while i < n:
        if _hist_off(hists[i], hists[anchor]) <= SCENE_LEAVE:
            i += 1
            continue
        k = i
        while k + 8 < n and _hist_off(hists[k], hists[k + 8]) > SCENE_SETTLE:
            k += 1
        k = -(-k // 8) * 8
        if k >= n:
            break
        if k - (cuts[-1] if cuts else 0) >= FPS and n - k >= FPS:
            cuts.append(k)
        anchor, i = k, k + 1
    return cuts


def _stats(thumbs: list) -> list:
    """[(mean, standard deviation)] of R, G and B over some frames."""
    out = []
    for c in range(3):
        values = [v for t in thumbs for v in t[c::3]]
        mean = sum(values) / len(values)
        out.append((mean, (sum((v - mean) ** 2 for v in values) / len(values)) ** 0.5))
    return out


def _grades(thumbs: list, counts: list, overlap: int) -> list:
    """Per piece, [(gain, offset)] for R, G and B that matches its colours to the piece before over the frames the
    two share (separately anchored pieces differ in tone), the piece before as already matched. Piece 0 keeps its
    own: None."""
    out, before = [None], None
    for i in range(1, len(thumbs)):
        prev = _stats(thumbs[i - 1][max(0, counts[i - 1] - overlap):counts[i - 1]])
        if before:  # the piece before is itself matched to the one before it
            prev = [(g * m + o, g * sd) for (m, sd), (g, o) in zip(prev, before)]
        grade = []
        for (pm, psd), (cm, csd) in zip(prev, _stats(thumbs[i][:overlap])):
            g = min(GRADE_GAIN[1], max(GRADE_GAIN[0], psd / csd if csd > 1 else 1.0))
            grade.append((round(g, 4), round(pm - g * cm, 2)))
        out.append(grade)
        before = grade
    return out


def _grade_filter(grade) -> str:
    """The lutrgb that applies one piece's grade (_grades); "" for none."""
    if not grade:
        return ""
    r, g, b = (f"'clip(val*{gain}+({offset}),0,255)'" for gain, offset in grade)
    return f",format=rgb24,lutrgb=r={r}:g={g}:b={b},format=yuv420p"


def _run(cmd: list) -> None:
    done = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if done.returncode:
        raise RuntimeError(f"ffmpeg: {done.stderr.strip()[-300:]}")


def _cut(ctx, src: str, tmp: str, session_id: str, job_id: str, pieces: list, on_frames: bool) -> list:
    """The source's pieces next to the job in the bucket, for the GPU boxes to fetch → [S3 key per piece]. On the
    frame (an anchored restyle: 24 fps, no sound, the box makes its own) or on the second (with the sound)."""
    keys = []
    for i, (start, length) in enumerate(pieces):
        clip, key = os.path.join(tmp, f"p{i}.mp4"), f"sessions/{session_id}/{job_id}-p{i}.mp4"
        if on_frames:  # -r: after setpts the last frame has no duration and was dropped
            cut = ["-vf", f"fps={FPS},trim=start_frame={start}" + (f":end_frame={start + length}" if length else "")
                   + ",setpts=PTS-STARTPTS", "-r", str(FPS), "-an"]
            _run([ctx.ffmpeg_bin, "-y", "-v", "error", "-i", src, *cut, "-c:v", "libx264", "-preset", "veryfast",
                  "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", clip])
        else:
            _run([ctx.ffmpeg_bin, "-y", "-v", "error", "-ss", f"{start:.3f}", "-i", src,
                  *(("-t", f"{length:.3f}") if length else ()), "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
                  "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", clip])
        ctx.s3.upload_file(clip, ctx.assets_bucket, key, ExtraArgs={"ContentType": "video/mp4"})
        keys.append(key)
    return keys


def _prepare(ctx, session_id: str, job_id: str, src_key: str, limit, anchored: bool) -> dict:
    """Cuts the source shot into pieces when it is longer than ~limit seconds and, for the anchors, grabs each
    piece's own first frame. An anchored restyle's pieces are cut on the frame, also where the scene changes
    (scene_cuts), and share SEAM frames with their neighbours (plan_restyle); an inpaint's are cut on the second.
    → {"videos": [S3 key per piece], "frames": [first frame's S3 key per piece] (anchored), and for a restyle in
    pieces "overlap": SEAM, "counts": [frames per piece], "total": the source's frames}"""
    out = {"videos": []}
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "src.mp4")
        ctx.s3.download_file(ctx.assets_bucket, src_key, src)
        if anchored and limit:  # ~5 s pieces, and new ones where the scene changes (Wan: one call)
            thumbs = _thumbs(ctx.ffmpeg_bin, src)
            pieces = plan_restyle(len(thumbs), scene_cuts(thumbs), limit)
            if len(pieces) > 1:
                out.update(overlap=SEAM, total=len(thumbs),
                           counts=[count or len(thumbs) - first for first, count in pieces])
        else:
            seconds = ffmpeg._probe_duration(ctx.ffmpeg_bin, ctx.ffprobe_bin, src) if limit else 0
            pieces = plan_pieces(seconds, limit) if limit else [(0.0, None)]
        out["videos"] = _cut(ctx, src, tmp, session_id, job_id, pieces, anchored) if len(pieces) > 1 else [src_key]
        if anchored:
            out["frames"] = _first_frames(ctx, src, tmp, session_id, job_id, pieces if len(pieces) > 1 else [(0, None)])
    return out


def _first_frames(ctx, src: str, tmp: str, session_id: str, job_id: str, pieces: list) -> list:
    """Each piece's own first frame of the source, next to the job in the bucket → [S3 key per piece]"""
    keys = []
    for i, (start, _) in enumerate(pieces):
        png, key = os.path.join(tmp, f"p{i}.png"), f"sessions/{session_id}/{job_id}-p{i}.png"
        _run([ctx.ffmpeg_bin, "-y", "-v", "error", "-i", src, "-vf", f"fps={FPS},select=eq(n\\,{start})",
              "-frames:v", "1", png])
        ctx.s3.upload_file(png, ctx.assets_bucket, key, ExtraArgs={"ContentType": "image/png"})
        keys.append(key)
    return keys


def _prepare_v2v(ctx, session_id: str, job_id: str, src_key: str, inp: dict, anchored: bool = False) -> dict:
    """A v2v's size (an upscale: twice the source's) and its pieces: as many as keep each under one LTX pass, cut on
    the frame (plan_v2v). → {"videos", "size": the result's [w, h], "ask": the box's [w, h], "counts": [frames per
    piece], "total": the source's frames}: the result is fitted to exactly the source's frames (_fit); anchored, also
    "frames": [each piece's own first source frame's S3 key]."""
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "src.mp4")
        ctx.s3.download_file(ctx.assets_bucket, src_key, src)
        w, h = _size(ctx.ffmpeg_bin, src)
        total = len(_thumbs(ctx.ffmpeg_bin, src))
        scale = v2v_scale(inp)
        ask = v2v_dims((w, h), scale)
        pieces = plan_v2v(total, ask)
        videos = _cut(ctx, src, tmp, session_id, job_id, pieces, True) if len(pieces) > 1 else [src_key]
        frames = _first_frames(ctx, src, tmp, session_id, job_id, pieces) if anchored else []
    return {"videos": videos, "size": [w * scale, h * scale], "ask": list(ask), "total": total,
            "counts": [count or total - first for first, count in pieces],
            **({"overlap": SEAM} if len(pieces) > 1 else {}), **({"frames": frames} if frames else {})}


def _start_anchor(ctx, inp: dict, frame_key: str, seed: int) -> str:
    """FLUX.2 klein repaints a piece's first frame in the target style alone: that piece's anchor.
    → image MCP job id"""
    style = (inp.get("style") or inp.get("prompt", "")).rstrip(". ")  # jobs made before `style` existed
    try:
        out = mcp_client.call_tool(ctx, mcp_client.IMAGE, "start_image", {
            "prompt": ANCHOR_PROMPT.format(style=style), "model": ANCHOR_MODEL, "seed": seed,
            "reference_image_urls": [mcp_client.public_input_url(ctx, frame_key)]})
    except RuntimeError as e:
        raise RuntimeError(f"화풍 기준 프레임(FLUX.2 klein)을 시작하지 못했습니다: {e}"[:300]) from None
    if out.get("status") == "FAILED" or not out.get("job_id"):
        raise RuntimeError(f"화풍 기준 프레임(FLUX.2 klein)을 시작하지 못했습니다: {out.get('error') or out}"[:300])
    return out["job_id"]


def _stage(job: dict):
    ext = job.get("externalId") or ""
    return json.loads(ext[len(STAGED):]) if ext.startswith(STAGED) else None


def _save_stage(ctx, job: dict, stage: dict, expect: dict) -> bool:
    """Writes a staged edit's next state into externalId: conditioned on the rev like jobs._save (the claim), or on the
    claim itself (other polls only touch progress meanwhile). The job dict follows, so the engine's next write on it
    expects the rev written here."""
    fields = {"externalId": STAGED + json.dumps(stage, separators=(",", ":")), "updatedAt": store.now()}
    if "rev" in expect:
        fields["rev"] = expect["rev"] + 1
    if not store.update_job(ctx, job["pk"].split("#")[1], job["jobId"], expect=expect, **fields):
        return False
    job.update(fields)
    return True


def _failure(inp: dict, error) -> str:
    """A failed GPU job's error as the user reads it. No GPU capacity becomes Korean but keeps the EC2 code, which is
    how jobs.py knows to retry it after a wait."""
    text = str(error or "영상 생성 실패")
    if not any(c in text.lower() for c in CAPACITY):
        return text[:300]
    model = inp.get("model", "ltx")
    label = next((m["label"] for m in (_catalog or DEFAULT_CATALOG)["models"] if m["id"] == model), model)
    offer = "다시 시도해 주세요" if model == "ltx" else "다시 시도하거나 LTX로 만들어 주세요"  # LTX is no way out of LTX
    return (f"GPU 용량 부족: 지금 AWS에 남는 GPU가 없어 {label.split(' (')[0]} 서버를 켜지 못했습니다. "
            f"잠시 뒤 {offer}. (InsufficientInstanceCapacity)")


def _join(ctx, clips: list) -> bytes:
    """The edited pieces back into one clip: concat demuxer, stream copy (same model, same size and codecs)."""
    with tempfile.TemporaryDirectory() as tmp:
        paths = [os.path.join(tmp, f"p{i}.mp4") for i in range(len(clips))]
        for path, clip in zip(paths, clips):
            with open(path, "wb") as f:
                f.write(clip)
        listing, out = os.path.join(tmp, "pieces.txt"), os.path.join(tmp, "joined.mp4")
        with open(listing, "w") as f:
            f.write("".join(f"file '{p}'\n" for p in paths))
        _run(ffmpeg.build_concat_cmd(ctx.ffmpeg_bin, listing, out))
        with open(out, "rb") as f:
            return f.read()


_SIZE = re.compile(r"Video: [^\n]*?, (\d{2,5})x(\d{2,5})")


def _size(ffmpeg_bin: str, path: str) -> tuple:
    """(width, height) of a clip, from ffmpeg's own header (the Lambda has no ffprobe)."""
    found = _SIZE.search(subprocess.run([ffmpeg_bin, "-hide_banner", "-i", path], capture_output=True, text=True,
                                        errors="replace").stderr)
    if not found:
        raise RuntimeError("원본 영상의 크기를 읽지 못했습니다")
    return int(found[1]), int(found[2])


def _fit(ctx, clips: list, src_key: str, overlap: int = 0, size=None, own_sound: bool = False, counts=None,
         total=None) -> bytes:
    """The edited pieces back into one clip at `size` (default the source's own), with the source's sound (or, with
    own_sound and one piece, the piece's: a v2v's generated rain or night), and exactly the source's frames on the
    24 fps clock (`total`, else counted). Each piece keeps the frames it was cut with (`counts`): the box rounds a
    clip up to 8k+1 frames with made-up ones at the end; a short result is held on its last frame. With overlap each
    later piece starts `overlap` frames before the one before ends (plan_restyle), is colour-matched to it there
    (_grades) and the two are dissolved over those frames. The box's grid size is scaled to cover the target and
    center-cropped."""
    with tempfile.TemporaryDirectory() as tmp:
        src, out = os.path.join(tmp, "src.mp4"), os.path.join(tmp, "fit.mp4")
        ctx.s3.download_file(ctx.assets_bucket, src_key, src)
        w, h = size or _size(ctx.ffmpeg_bin, src)
        total = total or len(_thumbs(ctx.ffmpeg_bin, src))
        inputs, thumbs = [], []
        for i, clip in enumerate(clips):
            inputs += ["-i", os.path.join(tmp, f"p{i}.mp4")]
            with open(inputs[-1], "wb") as f:
                f.write(clip)
            thumbs.append(_thumbs(ctx.ffmpeg_bin, inputs[-1]))
        # our pieces were cut at 24 fps and LTX makes 24 fps: laid on the clock frame by frame. A box's own single
        # clip (Wan's 16 fps) is resampled to 24 fps instead, which keeps its timing
        clock = f"setpts=N/{FPS}/TB,fps={FPS}" if overlap or counts else f"fps={FPS}"
        counts = [min(c, len(t)) if c else len(t) for c, t in zip(counts or [total] * len(clips), thumbs)]
        joined = overlap and len(clips) > 1
        grades = _grades(thumbs, counts, overlap) if joined else [None] * len(clips)
        graph = "".join(f"[{i}:v]{clock},trim=end_frame={counts[i]},setpts=PTS-STARTPTS,fps={FPS},format=yuv420p"
                        f"{_grade_filter(grades[i])}[v{i}];" for i in range(len(clips)))
        if joined:
            last, laid = "v0", counts[0]
            for i in range(1, len(clips)):
                graph += (f"[{last}][v{i}]xfade=transition=fade:duration={overlap / FPS}:"
                          f"offset={(laid - overlap) / FPS}[x{i}];")
                last, laid = f"x{i}", laid - overlap + counts[i]
            graph += f"[{last}]"
        else:
            graph += "".join(f"[v{i}]" for i in range(len(clips))) + f"concat=n={len(clips)}:v=1:a=0,"
        graph += (f"tpad=stop_mode=clone:stop={total},trim=end_frame={total},"
                  f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1[v]")
        sound = "0:a?" if own_sound and len(clips) == 1 else f"{len(clips)}:a?"
        # -r: after setpts the last frame has no duration and was dropped
        _run([ctx.ffmpeg_bin, "-y", "-v", "error", *inputs, "-i", src, "-filter_complex", graph, "-map", "[v]",
              "-map", sound, "-r", str(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt",
              "yuv420p", "-c:a", "copy", "-movflags", "+faststart", out])  # no -shortest: it cut the last frame
        with open(out, "rb") as f:
            return f.read()


def _off_source(ctx, body: bytes, src_key: str, first: int = 0, count=None, shape=None) -> tuple:
    """How far a clip the box made is from the source frames it was made of (`count` of them from `first`; default
    all), frame by frame: both at KEEP_GRID's size, the absolute RGB difference averaged over the frame and over each
    block. The source is first fitted to `shape` as the box fits it to the size it is asked for (covered, the middle
    kept), and each frame's figures are read against that source frame's own contrast (KEEP_SPREAD).
    → (the worst frame's mean, the worst block of any frame), in levels of 0-255 at the reference contrast"""
    long, short, block = KEEP_GRID
    with tempfile.TemporaryDirectory() as tmp:
        src, made, off, small = (os.path.join(tmp, name) for name in ("src.mp4", "made.mp4", "off.rgb", "small.rgb"))
        ctx.s3.download_file(ctx.assets_bucket, src_key, src)
        with open(made, "wb") as f:
            f.write(body)
        sw, sh = _size(ctx.ffmpeg_bin, src)
        w, h = (long, short) if sw >= sh else (short, long)
        cols, rows = w // block, h // block
        aw, ah = shape or (sw, sh)
        # the source as the box fits it to another shape: covered, the middle kept (in RGB: a crop of 4:2:0 frames
        # starts on an even pixel, which can be a pixel off the middle)
        crop = (f"scale={aw}:{ah}:force_original_aspect_ratio=increase,format=gbrp,crop={aw}:{ah},"
                if aw * sh != ah * sw else "")
        cut = f"trim=start_frame={first}" + (f":end_frame={first + count}" if count else "")
        sized = f"scale={w}:{h}:flags=area,format=gbrp"
        # the box's frames one by one, as _fit lays them; [d]: the difference per block, [s]: the source frame small
        _run([ctx.ffmpeg_bin, "-y", "-v", "error", "-i", made, "-i", src, "-filter_complex",
              f"[0:v]setpts=N/{FPS}/TB,fps={FPS},{sized}[a];"
              f"[1:v]fps={FPS},{cut},setpts=PTS-STARTPTS,fps={FPS},{crop}{sized},split[b][c];"
              f"[a][b]blend=all_mode=difference:shortest=1,scale={cols}:{rows}:flags=area,format=rgb24[d];"
              f"[c]scale={w // 4}:{h // 4}:flags=area,format=rgb24[s]",
              "-map", "[d]", "-f", "rawvideo", off, "-map", "[s]", "-f", "rawvideo", small])
        with open(off, "rb") as f:
            offs = f.read()
        with open(small, "rb") as f:
            smalls = f.read()
    n, m = cols * rows * 3, (w // 4) * (h // 4) * 3
    frames = min(len(offs) // n, len(smalls) // m)
    if not frames:
        raise RuntimeError("ffmpeg: 비교할 프레임이 없습니다")
    mean = worst = 0.0
    for i in range(frames):
        blocks = [sum(offs[at:at + 3]) / 3 for at in range(i * n, (i + 1) * n, 3)]
        spread = sum(sd for _, sd in _stats([smalls[i * m:(i + 1) * m]])) / 3
        scale = KEEP_SPREAD / max(spread, KEEP_FLAT)
        mean, worst = max(mean, sum(blocks) / len(blocks) * scale), max(worst, max(blocks) * scale)
    return mean, worst


def _enlarged(ctx, src_key: str) -> bytes:
    """The source itself at twice its size, by ffmpeg alone (PLAIN_2X): its own frames, timing and sound."""
    with tempfile.TemporaryDirectory() as tmp:
        src, out = os.path.join(tmp, "src.mp4"), os.path.join(tmp, "plain.mp4")
        ctx.s3.download_file(ctx.assets_bucket, src_key, src)
        _run([ctx.ffmpeg_bin, "-y", "-v", "error", "-i", src, "-vf", PLAIN_2X, "-c:v", "libx264", "-preset", "veryfast",
              "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", out])
        with open(out, "rb") as f:
            return f.read()


def _kept(ctx, job: dict, clips: list, src_key: str, stage: dict) -> tuple:
    """A KEEP task's pieces as the box made them, each measured against the source frames it was cut from
    (_off_source). The source's own picture is fitted and delivered like any v2v. Pieces the box drew again are
    not: a plain upscale becomes the source enlarged by ffmpeg, with a line for the job (_note) and one for the chat
    (_chat); any other task fails saying why.
    → (the clip to deliver in place of the box's, or None; what the asset's meta says of it)"""
    inp, overlap, first, mean, block = job["input"], int(stage.get("overlap") or 0), 0, 0.0, 0.0
    for clip, count in zip(clips, stage.get("counts") or [None] * len(clips)):
        off = _off_source(ctx, clip, src_key, first, count, stage.get("ask"))
        mean, block, first = max(mean, off[0]), max(block, off[1]), first + (count or 0) - overlap
    meta = {"off": {"mean": round(mean, 1), "block": round(block, 1)}}
    most = KEEP_BLOCK_UPSCALE if inp["task"] == UPSCALE else KEEP_BLOCK
    if mean <= KEEP_MEAN and block <= most:
        return None, meta
    far = (f"화면 평균 차이 {mean:.1f}, 기준 {KEEP_MEAN}" if mean > KEEP_MEAN
           else f"가장 달라진 곳의 차이 {block:.1f}, 기준 {most}")
    if inp["task"] != UPSCALE:
        raise RuntimeError(f"{REDRAWN}: GPU가 만든 결과가 원본 그림과 달라({far}) 쓰지 않았습니다. "
                           "원본 샷은 그대로 있고, 다시 시도해도 같은 결과일 수 있습니다.")
    job["_note"] = f"{REDRAWN}: GPU가 만든 결과가 원본 그림과 달라({far}) 원본을 그대로 2배로 키운 영상으로 대신했습니다."
    ip = store.get_ip(ctx, job["pk"].split("#")[1], inp["sourceIpId"]) if inp.get("sourceIpId") else None
    job["_chat"] = (f"{ip['name'] + ' 샷의 ' if ip and ip.get('name') else ''}2배 업스케일은 원본 보존 검사를 통과하지 못했어요. "
                    f"이유: GPU가 그림을 다시 그려 원본과 달라졌어요({far}). 그 결과는 쓰지 않고, 원본을 그대로 2배 크기로 키운 "
                    "영상을 대신 넣었어요. 그림·움직임·소리는 원본과 같고, 새 디테일이 더해진 것은 아니에요.")
    return _enlarged(ctx, src_key), {**meta, "plain": True, "model": "ffmpeg"}


class MediagenVideoProvider:
    name = "mediagen_video"

    def submit(self, job: dict, ctx) -> str:
        session_id = job["pk"].split("#")[1]
        inp = job["input"]
        model = inp.get("model", "ltx")
        aspect = inp.get("aspect_ratio", "16:9")
        image_url = mcp_client.public_input_url(ctx, inp["imageKey"]) if inp.get("imageKey") else None
        if inp.get("edit"):
            return self._submit_edit(job, ctx, session_id, inp)
        if model == "wan-animate":
            w, h = DIMS[model].get(aspect, DIMS[model]["16:9"])
            tool, args = "wan_animate_start", {
                "reference_image_url": image_url,
                "driving_video_url": mcp_client.public_input_url(ctx, _shot_key(ctx, session_id, inp["driving_shot_job_id"])),
                "prompt": inp.get("prompt", ""), "seconds": inp.get("seconds", 4), "width": w, "height": h}
        else:
            args = {"prompt": inp.get("prompt", ""), "seconds": inp.get("seconds", 5)}
            if image_url:
                args["image_url"] = image_url
            if inp.get("lastImageKey"):
                args["last_image_url"] = mcp_client.public_input_url(ctx, inp["lastImageKey"])
            if model in DIMS:
                dims = LTX_LONG_DIMS if model == "ltx" and args["seconds"] > LTX_FULL_RES_MAX_SEC else DIMS[model]
                args["width"], args["height"] = dims.get(aspect, dims["16:9"])
            tool = start_tool(model)
            if tool == "video_start":  # a model promoted on the MCP (Kandinsky 6.0 and later ones)
                args = {"model": model, **args}
        return _start(ctx, tool, args)

    def _submit_edit(self, job, ctx, session_id, inp) -> str:
        """One call on the source shot, or a staged edit: the anchor first (restyle), the source in pieces (a long LTX
        restyle or inpaint). The image MCP draws 1216x688 only, so a 9:16 clip gets no matching anchor (prompt only)."""
        tool, src_key = _edit_tool(inp), _shot_key(ctx, session_id, inp["sourceShotJobId"])
        if tool == "ltx_v2v_start":  # sized, in pieces when one pass cannot hold it, fitted back in collect
            # a task that keeps the picture: every piece starts on its own first source frame (the box's frame 0)
            anchored = keeps(inp) and "reference_image_url" in catalog(ctx)["tools"].get(tool, ())
            stage = _prepare_v2v(ctx, session_id, job["jobId"], src_key, inp, anchored)
            frames = stage.get("frames") or [None] * len(stage["videos"])
            return STAGED + json.dumps({**stage, "jobs": [
                _start(ctx, tool, _edit_args(ctx, inp, video, frame and mcp_client.public_input_url(ctx, frame), stage))
                for video, frame in zip(stage["videos"], frames)]})
        anchored = _anchored(ctx, inp, tool)
        limit = CHUNK_SEC.get(tool) if anchored or inp["edit"] != "restyle" else None  # pieces only help with anchors
        if not anchored and not (limit and float(inp.get("seconds") or 0) > limit * CHUNK_SLACK):
            return _start(ctx, tool, _edit_args(ctx, inp, src_key))
        stage = _prepare(ctx, session_id, job["jobId"], src_key, limit, anchored)
        if anchored:  # klein repaints every piece's own first frame, one seed for all; the pieces start once all are drawn
            seed = random.randint(1, 2 ** 31 - 1)
            images = [_start_anchor(ctx, inp, frame, seed) for frame in stage.pop("frames")]
            return STAGED + json.dumps({**stage, "seed": seed, "images": images})
        return STAGED + json.dumps({**stage, "jobs": [_start(ctx, tool, _edit_args(ctx, inp, v)) for v in stage["videos"]]})

    def _status(self, job, ctx) -> dict:
        return call_tool(ctx, status_tool(job["input"]), {"job_id": job["externalId"]})

    def status(self, job: dict, ctx) -> tuple:
        stage = _stage(job)
        if stage is not None:
            state, text = self._staged_status(job, ctx, stage)
            pieces, eta = len(stage["videos"]), job["input"].get("etaMinutes") or 0
            # a restyle in pieces (a v2v's have "ask"): the card's own figure (web SHOT_TYPICAL) is one call's
            if state == "running" and stage.get("overlap") and not stage.get("ask"):
                # a scene change can add a piece to what etaMinutes counted
                text += f" · 조각마다 ~{PIECE_MIN}분, 전체 보통 ~{max(eta, restyle_minutes(pieces))}분"
            elif state == "running" and stage.get("ask") and pieces > 1:  # a v2v in pieces, one after another
                per = v2v_piece_minutes(job["input"])
                text += f" · 조각마다 ~{per}분, 전체 보통 ~{max(eta, per * pieces)}분"
            return state, text
        st = self._status(job, ctx)
        state = st.get("status")
        if state == "SUCCEEDED":
            if not st.get("url"):
                return ("failed", "결과 영상 URL이 없습니다")
            job["_resultUrl"] = st["url"]  # in memory: the same _settle pass collects it without a re-poll
            return ("done", "")
        if state == "FAILED":
            return ("failed", _failure(job["input"], st.get("error")))
        return ("running", _progress(st))

    def _staged_status(self, job, ctx, stage) -> tuple:
        inp = job["input"]
        if "jobs" not in stage:  # klein is drawing the anchor
            drawn = [mcp_client.call_tool(ctx, mcp_client.IMAGE, "get_image_status", {"job_id": i})
                     for i in stage["images"]]
            bad = next((d for d in drawn if d.get("status") == "FAILED"), None)
            if bad:
                return ("failed", f"화풍 기준 프레임(FLUX.2 klein)을 그리지 못했습니다: {bad.get('error') or '원인 미상'}"[:300])
            urls = [d["url"] for d in drawn if d.get("status") == "SUCCEEDED" and d.get("url")]
            if len(urls) < len(drawn):
                # no model's name in a running line
                return ("running", f"화풍 기준 프레임 그리는 중 ({len(urls)}/{len(drawn)})")
            return self._start_pieces(job, ctx, {**stage, "anchors": urls})
        if stage["jobs"] is None or None in stage["jobs"]:  # another poll is starting the pieces
            if store.age_sec(stage["claimedAt"]) > START_STALE_SEC:
                return ("failed", "영상 편집을 시작하지 못했습니다 (시간 초과)")
            return ("running", STARTING)
        sts = [call_tool(ctx, status_tool(inp), {"job_id": j}) for j in stage["jobs"]]
        bad = next((s for s in sts if s.get("status") == "FAILED"), None)
        if bad:
            return ("failed", _failure(inp, bad.get("error")))
        done, total = [s.get("url") for s in sts if s.get("status") == "SUCCEEDED"], len(stage["videos"])
        if len(done) == len(sts):
            if not all(done):
                return ("failed", "결과 영상 URL이 없습니다")
            job["_resultUrls"] = done  # in memory, like _resultUrl
            return ("done", "")
        running = _progress(next(s for s in sts if s.get("status") != "SUCCEEDED"))
        return ("running", f"{running} (조각 {len(done)}/{total} 완료)" if total > 1 else running)

    def _start_pieces(self, job, ctx, stage) -> tuple:
        """Starts every piece of an anchored restyle, each on its own anchor, once all anchors are drawn: they queue
        on the box together, so a job sent meanwhile does not get in between. Overlapping polls all get here, so the
        start is claimed first (rev-conditioned); the winner starts the GPU jobs and records their ids."""
        claimed = {**stage, "jobs": None, "claimedAt": store.now()}
        if not _save_stage(ctx, job, claimed, {"rev": job.get("rev", 0)}):
            return ("running", STARTING)
        inp, tool = job["input"], _edit_tool(job["input"])
        try:
            started = [_start(ctx, tool, _edit_args(ctx, inp, video, anchor, stage))
                       for video, anchor in zip(stage["videos"], stage["anchors"])]
        except Exception as e:  # noqa: BLE001 — the claim is ours: fail now (jobs.py retries a GPU blip) than go stale
            return ("failed", f"영상 편집을 시작하지 못했습니다: {e}"[:300])
        _save_stage(ctx, job, {**claimed, "jobs": started}, {"externalId": job["externalId"]})
        total = len(stage["videos"])
        return ("running", f"제출됨 (조각 0/{total} 완료)" if total > 1 else "제출됨")

    def collect(self, job: dict, ctx) -> list:
        session_id = job["pk"].split("#")[1]
        inp, stage = job["input"], _stage(job)
        if stage is not None:
            urls = job.get("_resultUrls") or [call_tool(ctx, status_tool(inp), {"job_id": j}).get("url")
                                              for j in stage["jobs"]]
        else:
            urls = [job.get("_resultUrl") or (self._status(job, ctx).get("url") if job.get("externalId") else None)]
        if not all(urls):
            raise RuntimeError("결과 영상 URL이 없습니다")
        clips = [mcp_client.download(u) for u in urls]
        measured = {}
        if inp.get("edit") == "restyle":  # at the source's size and with its sound, the pieces dissolved at the seams
            src_key = _shot_key(ctx, session_id, inp["sourceShotJobId"])
            stage = stage or {}
            body = _fit(ctx, clips, src_key, int(stage.get("overlap") or 0), counts=stage.get("counts"),
                        total=stage.get("total"))
        elif stage and stage.get("size"):  # a v2v at its size (an upscale twice the source's, with the source's sound)
            src_key = _shot_key(ctx, session_id, inp["sourceShotJobId"])
            # a task that keeps the picture is measured first: what the box drew again is replaced or refused
            plain, measured = _kept(ctx, job, clips, src_key, stage) if keeps(inp) else (None, {})
            # its pieces dissolved and colour-matched over the frames they share; a task that keeps the picture
            # keeps the source's sound too (the box can add a soundtrack of its own)
            body = plain or _fit(ctx, clips, src_key, int(stage.get("overlap") or 0), size=stage["size"],
                                 own_sound=v2v_scale(inp) == 1 and not keeps(inp), counts=stage.get("counts"),
                                 total=stage.get("total"))
        else:
            body = clips[0] if len(clips) == 1 else _join(ctx, clips)
        asset_id = store.new_id("ast")
        key = s3_key_for(session_id, asset_id, "mp4")
        ctx.s3.put_object(Bucket=ctx.assets_bucket, Key=key, Body=body, ContentType="video/mp4")
        anchors = (stage or {}).get("anchors") or [store.public_url(ctx, k) for k in (stage or {}).get("frames") or []]
        meta = {"model": inp.get("model", "ltx"), "prompt": inp.get("prompt", ""),
                "aspect_ratio": inp.get("aspect_ratio", "16:9"),
                **{k: inp[k] for k in ("edit", "task", "sourceShotJobId") if inp.get(k)},
                **({"anchors": anchors} if anchors else {}),
                **({"pieces": len(urls)} if len(urls) > 1 else {}), **measured}
        # an edit keeps its source's IP on the asset (the job input has none, so "다시 뽑기" does not re-make it i2v)
        owner = {"ipId": inp["sourceIpId"]} if inp.get("sourceIpId") and not inp.get("ipId") else {}
        return [{"assetId": asset_id, "kind": "shot", "key": key, "contentType": "video/mp4", "meta": meta, **owner}]


def _progress(st: dict) -> str:
    phase = phase_text(st.get("phase"))
    pct = None
    if isinstance(st.get("progress"), (int, float)):
        pct = st["progress"] * 100 if st["progress"] <= 1 else st["progress"]
    elif isinstance(st.get("step"), (int, float)) and st.get("steps"):
        pct = st["step"] / st["steps"] * 100
    return f"{phase} {round(pct)}%" if pct is not None else phase
