"""edit_video_shot: a video-to-video edit of an existing shot on the attached video MCP (mediagen GPU boxes): an LTX
restyle, an LTX IC-LoRA task (upscale, deblur, colorize, ...), an LTX inpaint or the Wan VACE restyle. The edit is a
`shot` job on the mediagen_video provider: it starts when its source shot is done and cut_trailer takes it like any
shot. Which edits, models and LTX tasks exist is read from the MCP (mediagen_video.catalog).
"""
from __future__ import annotations

from server import jobs, store
from server.providers import mediagen_video

EDITS = ("restyle", "v2v", "inpaint")
SPEC = {
    "name": "edit_video_shot",
    "description": (
        "이미 만든 영상 샷(shot_job_id)을 영상-투-영상으로 고친 새 샷 작업을 등록한다. 원본 샷은 그대로 남고, 결과도 영상 샷이라 "
        "cut_trailer에 넣을 수 있다. 원본이 아직 만들어지는 중이면 끝난 뒤 자동 시작한다 (LTX 편집 하나에 ~6분, "
        "같은 LTX GPU에 앞선 작업이 있으면 그만큼 더). "
        "edit: restyle=움직임·구도·타이밍은 그대로 두고 화풍만 바꾼다(수채화, 애니메이션 셀, 유화 등). 5초보다 긴 LTX 샷은 "
        "약 5초 조각으로 나누고, FLUX.2 klein이 조각마다 그 조각의 첫 프레임을 style 화풍으로 먼저 그려 기준으로 쓴다(기준 "
        "프레임은 함께 그려 모두 ~2분). 조각은 함께 GPU 대기열에 올라 하나씩 바뀌고(조각마다 ~6분) 이음새에서 겹친 프레임끼리 섞인다. LTX restyle "
        "결과의 etaMinutes가 앞선 LTX 작업까지 넣은 대략의 완료 시간이다. 결과는 원본과 같은 크기·소리다. "
        "v2v=LTX IC-LoRA 작업 하나를 적용한다(task: upscale 원본의 정확히 2배 크기·같은 길이·원본 소리, ~2.7초 조각으로 "
        "차례로 돌아 조각마다 ~9분이고 결과의 etaMinutes가 앞선 LTX 작업까지 넣은 완료 시간, deblur, decompress, "
        "colorize 흑백 채색, day_to_night 낮→밤, relight 재조명, water 비·물 효과, clean_plate 인물 지우기 등; upscale 외에는 "
        "원본과 같은 크기). upscale·deblur·decompress는 원본 그림을 그대로 지켜야 해서 결과를 원본과 프레임마다 "
        "비교한다(원본 보존 검사): GPU가 그림을 다시 그렸으면 upscale은 원본을 그대로 2배로 키운 영상으로 대신하고 "
        "deblur·decompress는 실패로 끝나며, 그 작업의 error가 '원본 보존 검사 실패'로 시작한다. "
        "inpaint=나머지는 그대로 두고 한 가지만 바꾼다(날씨·계절·조명·배경, 인물 얼굴은 유지)."),
    "inputSchema": {"json": {"type": "object", "properties": {
        "shot_job_id": {"type": "string", "description": "고칠 영상 샷의 jobId (make_video_shot·make_action_shot·"
                                                         "animate_character·edit_video_shot)"},
        "edit": {"type": "string", "enum": list(EDITS)},
        "prompt": {"type": "string", "description": "영어. restyle은 목표 화풍을 맨 앞에, 그다음 원본 샷의 장소·조명을 그대로 "
                                                    "옮긴 짧은 장면 묘사(예: watercolor painting, soft paper texture, a "
                                                    "boy in an orange jacket running inside a dark space station hangar "
                                                    "under cool blue lights). 원본에 없는 하늘·야외·낮 같은 말은 쓰지 "
                                                    "않는다. v2v·inpaint는 완성된 장면(그림과 소리). upscale·deblur·"
                                                    "decompress는 원본에 보이는 것만 짧게(새 소품·무늬·배경을 더하지 않는다)"},
        "style": {"type": "string", "description": "restyle은 필수. 영어로 목표 화풍만, 장면·인물·사물·동작 없이(예: watercolor "
                                                   "painting, soft paper texture, loose washes). 첫 프레임을 이 말로만 "
                                                   "다시 그린다: 장면 단어가 섞이면 첫 프레임에 없는 배경·소품까지 그려 "
                                                   "결과가 원본의 움직임·구도에서 벗어난다"},
        "task": {"type": "string", "description": "v2v는 필수, inpaint는 선택(기본 water). 영상 MCP ltx_list_tasks의 작업 이름"},
        "model": {"type": "string", "description": "restyle만. ltx=LTX-2.3(기본), "
                                                   "wan-animate=Wan2.1-VACE 창 단위 restyle(사용자가 Wan을 고를 때)"},
        "keep_level": {"type": "number", "minimum": 0, "maximum": 1,
                       "description": "inpaint만. 원본 유지 정도: 0.3(기본, 날씨·계절은 바뀌고 인물은 유지)부터 0.55(효과 강함)까지"},
    }, "required": ["shot_job_id", "edit", "prompt"]}},
}


def _err(code, message):
    return {"error": code, "message": message}


def edit_video_shot(ctx, session, args):
    sid = session["sessionId"]
    by_id = {j["jobId"]: j for j in store.snapshot(ctx, sid)["jobs"]}
    shot_id = args.get("shot_job_id")
    src = by_id.get(shot_id) if isinstance(shot_id, str) else None
    if not src or src["kind"] != "shot":
        return _err("not_found", f"영상 샷 작업을 찾을 수 없습니다: {shot_id}. 상태(state)에 있는 id만 쓰세요.")
    if src["status"] == "failed":
        return _err("bad_args", "실패한 샷은 고칠 수 없습니다. 다른 샷의 jobId를 쓰세요.")
    edit = args.get("edit")
    prompt = args["prompt"].strip() if isinstance(args.get("prompt"), str) else ""
    if edit not in EDITS or not prompt:
        return _err("bad_args", f"edit은 {'|'.join(EDITS)} 중 하나이고 prompt(영어)가 필요합니다")
    # model is the restyle's choice (LTX or Wan); v2v and inpaint have one, so a model sent with them is ignored
    model = (args.get("model") or "ltx") if edit == "restyle" else "ltx"
    tool = mediagen_video.EDIT_TOOL.get((edit, model))
    if not tool:
        options = [m for e, m in mediagen_video.EDIT_TOOL if e == edit]
        return _err("bad_args", f"{edit}의 model은 {'|'.join(options)} 중 하나여야 합니다")
    cat = mediagen_video.catalog(ctx)
    row = next((m for m in cat["models"] if m["id"] == model), None)
    if tool not in cat["tools"] or not row or row["status"] in mediagen_video.UNUSABLE:
        why = f" ({row['status']})" if row and row["status"] in mediagen_video.UNUSABLE else ""
        return _err("unavailable", f"연결된 영상 MCP에서 지금 {tool}을(를) 쓸 수 없습니다{why}")
    inp = {"edit": edit, "model": model, "prompt": prompt, "sourceShotJobId": src["jobId"],
           "aspect_ratio": src["input"].get("aspect_ratio", "16:9"), "seconds": src["input"].get("seconds")}
    source_ip = src["input"].get("ipId") or src["input"].get("sourceIpId")
    if source_ip:
        inp["sourceIpId"] = source_ip
    if edit == "restyle":  # klein repaints the first frame from these words alone (mediagen_video.ANCHOR_PROMPT)
        inp["style"] = args["style"].strip() if isinstance(args.get("style"), str) else ""
        if not inp["style"]:
            return _err("bad_args", "restyle은 style이 필요합니다: 영어로 목표 화풍만, 장면 묘사 없이 "
                                    "(예: watercolor painting, soft paper texture)")
    task = args.get("task")
    if edit == "v2v" or (edit == "inpaint" and task):
        tasks = [t["task"] for t in cat["tasks"]]
        # several IC-LoRAs may run together ("water+day_to_night")
        if not isinstance(task, str) or not all(part in tasks for part in task.split("+")):
            return _err("bad_args", f"task는 {'|'.join(tasks)} 중 하나여야 합니다 (영상 MCP ltx_list_tasks)")
        inp["task"] = task
    if edit == "inpaint" and args.get("keep_level") is not None:
        level = args["keep_level"]
        if isinstance(level, bool) or not isinstance(level, (int, float)) or not 0 <= level <= 1:
            return _err("bad_args", "keep_level은 0–1 사이 숫자여야 합니다 (보통 0.3)")
        inp["keep_level"] = level
    # The ETA counts klein's anchors and the pieces, after the LTX jobs already on the box
    ahead = sum(1 for j in by_id.values() if j["status"] in ("queued", "running") and mediagen_video.on_ltx_box(j))
    try:  # a finished source is planned as the job will plan it (its scene changes add pieces)
        src_key = mediagen_video._shot_key(ctx, sid, src["jobId"]) if src["status"] == "done" else None
    except RuntimeError:
        src_key = None
    minutes = mediagen_video.edit_minutes(ctx, inp, ahead, src_key)
    eta = {"etaMinutes": minutes} if minutes else {}
    # The ETA is kept on the job too: its first status lines state no wait, so the card shows this meanwhile
    job = jobs.create_job(ctx, sid, "shot", "mediagen_video", {**{k: v for k, v in inp.items() if v is not None}, **eta},
                          [src["jobId"]])
    # model, seconds: what the edit runs on and the length it keeps (its source's), so the reply names the real model
    return {"jobId": job["jobId"], "model": model,
            **({"seconds": inp["seconds"]} if inp["seconds"] is not None else {}), **eta}
