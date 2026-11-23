"""One chat turn: Bedrock Converse tool-use loop over the session state; result lands on the pending message."""
from __future__ import annotations
import json
import re
import time
import traceback
from datetime import datetime, timedelta, timezone

from server import connections, game_design, gamespec, i18n, jobs, prompts, store, tools, waits
from server.i18n import tr
from server.providers import rig

MAX_ROUNDS = 12  # registering a whole asset list can take a round per tool when the model calls them one by one
HISTORY_MESSAGES = 20
TURN_BUDGET_SEC = 720  # stop starting rounds before the 900 s Lambda timeout (a round can take ~150 s)
STALE_TURN_SEC = 960  # longer than the Lambda timeout: a live turn is never failed early
# The lines the server itself puts into a bubble: 해요체, what happened and what to do, no internal word
LIMIT_NOTE = "한 번에 할 수 있는 일을 다 써서 여기서 멈췄어요. ‘이어서 해줘’라고 보내 주세요."
TIME_NOTE = "시간이 오래 걸려 여기서 멈췄어요. ‘이어서 해줘’라고 보내 주세요."
TRUNCATED = "답변이 너무 길어져 끝까지 쓰지 못했어요. 요청을 나눠서 다시 보내 주세요."
# A turn that threw (the model call, a tool): the exception goes to the log; what the turn had made stays
FAILED_NOTE = "죄송해요, 요청을 처리하지 못했어요. 잠시 뒤 같은 요청을 다시 보내 주세요. 만들어 둔 그림과 작업은 그대로 있어요."
KST = timezone(timedelta(hours=9), "KST")  # the users are in Korea: every time the model reads is theirs


def run_turn(ctx, session_id: str, message_id: str) -> None:
    snap = store.snapshot(ctx, session_id)
    message = next((m for m in snap["messages"] if m["messageId"] == message_id), None)
    if not message or message["status"] != "pending":
        return
    # The turn answers in the language of the page that sent the message (the payload's, set by app.handler), never
    # the session's, which another page's request may have changed since
    if not store.update_message(ctx, session_id, message, expect={"claimedAt": None}, claimedAt=store.now()):
        return  # a duplicate async delivery: the first invocation owns this turn
    try:
        status, text = _loop(ctx, snap, message)
    except Exception:  # model or tool failure: the message must never stay pending
        traceback.print_exc()
        status, text = "failed", tr(FAILED_NOTE)
    store.update_message(ctx, session_id, message, status=status, text=text)


def _loop(ctx, snap, message) -> tuple:
    """→ (status, text) for the assistant message."""
    session = snap["session"]
    messages = history(snap["messages"], message["messageId"])
    if not messages:
        raise ValueError("대화에 사용자 메시지가 없습니다")
    system = [{"text": prompts.system(i18n.lang()).replace("{state}", state_summary(snap))}]
    promoted = prompts.promoted_models(ctx)  # models the user approved through the open-model scout
    if promoted:
        system.append({"text": promoted})
    # the newest request ends with what is running now: in a long session old answers' progress outweighs the state
    if messages[-1]["role"] == "user":
        messages[-1]["content"][0]["text"] += (f"\n\n[서버 메모 · {kst(store.now())} · 지금 진행 중인 작업: {in_flight(snap)}. "
                                               "대화 기록 속 예전 답변의 진행 상황은 그때의 것이다.]")
    design = game_design.for_turn(snap["messages"], message["messageId"])
    pending_index = next(i for i, m in enumerate(snap["messages"]) if m["messageId"] == message["messageId"])
    asked = next((m for m in reversed(snap["messages"][:pending_index]) if m["role"] == "user"), None)
    source_prompt = asked["text"] if asked else ""
    max_tokens = 32000  # an episodic authored GameSpec (stories, 70 entities) runs past 16k; the prompt need not say "게임"
    if design:
        system.append({"text": "현재 사용자 게임 설계(서버 검증 데이터): "
                       + json.dumps(design, ensure_ascii=False)
                       + "\nmake_game에 새 authored world와 단계별 mission을 포함한다. "
                         "선택한 IP와 역할을 그대로 사용한다. sourcePrompt는 원문 그대로 저장한다."})
    started = time.monotonic()  # the MCP listing below counts against the turn budget too
    mcp_specs, mcp_routes = connections.agent_tools(ctx, session.get("userSub", ""))  # the user's own MCP servers
    tool_config = {"tools": [{"toolSpec": spec} for spec in tools.TOOL_SPECS + mcp_specs]}
    last_text = ""
    # made: this turn made a game; held: a tool put (or kept) its request on hold; refused: make_game refused it for
    # a reason that is not a missing 3D (_keep_hold)
    turn = {"made": False, "held": False, "refused": False}

    def out_of_time():
        return time.monotonic() - started > TURN_BUDGET_SEC

    def done(text):
        text = _strip_marker(text)
        _keep_hold(ctx, session["sessionId"], asked, text, turn)  # the reply's word of a hold is on record
        return "done", text

    for _ in range(MAX_ROUNDS):
        if out_of_time():
            return done(_join(last_text, tr(TIME_NOTE)))
        resp = ctx.bedrock_rt_east.converse(modelId=ctx.agent_model_id, system=system, messages=messages,
                                            toolConfig=tool_config, inferenceConfig={"maxTokens": max_tokens})
        if resp.get("stopReason") == "max_tokens":
            return "failed", tr(TRUNCATED)  # a cut-off reply (e.g. half a GameSpec) must never look done
        reply = resp["output"]["message"]
        messages.append(reply)
        text = "".join(b.get("text", "") for b in reply["content"]).strip()
        uses = [b["toolUse"] for b in reply["content"] if "toolUse" in b]
        if resp.get("stopReason") != "tool_use" or not uses:
            # text written before tool calls is part of the answer too (the final block often refers to it)
            return done(_join(last_text, text) if text else (last_text or tr("완료했어요.")))
        last_text = _join(last_text, text) if text and text != last_text else last_text
        results = []
        for use in uses:
            if out_of_time():
                return done(_join(last_text, tr(TIME_NOTE)))
            args = dict(use.get("input") or {})
            if use["name"] == "make_game":
                if design:
                    args["_game_design"] = design
                    if design.get("castIpIds"):
                        args["cast_ip_ids"] = design["castIpIds"]
                # The request is supplied by the server, never reconstructed by the model.
                args["_source_prompt"] = source_prompt
            mcp = mcp_routes.get(use["name"])
            result = store.plain(connections.run_agent_tool(mcp, args, started + TURN_BUDGET_SEC) if mcp
                                 else tools.run_tool(ctx, session, use["name"], args, deadline=started + TURN_BUDGET_SEC))
            if not mcp and isinstance(result.get("jobId"), str) and "error" not in result:
                result["job"] = _job_facts(ctx, session["sessionId"], result["jobId"])
            if not mcp and "error" in result:  # 작업 기록 keeps a plain line of it (tools.summarize): the log, the rest
                print(f"tool refused: {use['name']} {result['error']}: {result.get('message')}")
            if not mcp:
                turn["held"] |= _note_hold(ctx, session["sessionId"], asked, result)
                turn["made"] |= use["name"] == "make_game" and "error" not in result
                turn["refused"] |= use["name"] == "make_game" and result.get("error") not in (None, *tools.WAITS_FOR_3D)
                watch(ctx, session["sessionId"], use["name"], result)  # its end is told in the chat (tell_finished)
            results.append({"toolResult": {"toolUseId": use["toolUseId"], "content": [{"json": result}],
                                           "status": "error" if "error" in result else "success"}})
            # in the turn's language; the connection's name is the user's own and stays as it is
            label = tr("MCP 도구: {server} · {tool}", server=mcp[0]["name"], tool=mcp[1]) if mcp else None
            summary = ((tools.clip(tr("{label} 실패: {why}", label=label, why=result.get("message") or result["error"]))
                        if "error" in result else label)
                       if mcp else tools.summarize(use["name"], args, result))
            message["toolEvents"].append({"tool": use["name"], "summary": summary,
                                          "ts": store.now()})
            store.update_message(ctx, session["sessionId"], message, toolEvents=message["toolEvents"])
        messages.append({"role": "user", "content": results})
    return done(_join(last_text, tr(LIMIT_NOTE)))


# The server's notes to the model, which a reply (Korean or English) may echo; the notes themselves stay Korean
MARKER = re.compile(r"\[(?:이 답변에서 실제로 실행한 도구:|서버 메모 · |Tools (?:actually |really )?(?:run|executed|used) in this "
                    r"(?:reply|answer):|Server (?:note|memo) · )[^\]]*\]\s*", re.I)
# An id or a colour code the reply put in brackets after a name ("테오(ip_98e2ca089d)", "달빛 보라(#7f8cff)"): the
# bracket goes and the name stays. An id that stands by itself is left: the user may have asked for it.
BRACKETED = re.compile(r"\s?\((?:(?:ip|job|gm|ast|ses|msg)_[0-9a-f]{6,}|#[0-9a-fA-F]{6})\)")


def _strip_marker(text: str) -> str:
    """The history note for the model, never part of what the user reads (the model sometimes echoes it), nor an id
    or a colour code in brackets."""
    return humanize_tools(BRACKETED.sub("", MARKER.sub("", text)).strip()) or tr("완료했어요.")


# What the studio calls each of the agent's tools: the reply names the button, never the internal tool. The words
# are 작업 기록's (tools._LABELS); an IP made in chat is no one kind, so it is "IP 만들기".
TOOL_LABELS = {**tools._LABELS, "create_ip_asset": "IP 만들기"}
# ... and the state's own raw values (a genre id, check_failed); the other states are plain words
STATE_LABELS = {**gamespec.GENRE_LABELS, "check_failed": "검사 실패"}
# ... and the prompt's and the tools' own words for things the screen calls otherwise
_STEP = waits.STEP_LABEL
WORD_LABELS = {"description": "묘사", "turntable": _STEP["render3d"], "GPU 박스": "GPU 서버"}
_SAID = {**TOOL_LABELS, **STATE_LABELS, **WORD_LABELS}
# The particle after the word, which goes by the word's last sound. 이 is the subject particle only when no Hangul
# follows it: "sf-shooter이고" is a copula (이고, 이며, 이면 …) and is left as written.
_PARTICLE = r"(이에요|예요|을|를|이(?![가-힣])|가|은|는|과|와|으로|로)?"
_TOOL_NAME = re.compile(r"`?(?<![A-Za-z0-9_])(" + "|".join(map(re.escape, sorted(_SAID, key=len, reverse=True)))
                        + r")(?![A-Za-z0-9_])(?:\(\))?`?" + _PARTICLE)
# ... and the older words for the steps of a 3D chain, which a session's earlier replies still hold and the model
# repeats: the reply says the cards' words (waits.STEP_LABEL). The old word in brackets is a gloss and stays
# ("움직임 뼈대(리깅)"); 리깅 as a verb (리깅된, 리깅하지 않는) becomes 뼈대 작업, which takes the same endings.
_OLD_WORDS = tuple((re.compile(r"(?<![(（A-Za-z])" + pattern + _PARTICLE), label) for pattern, label in (
    (r"3D 렌더(?!링)(?:\(턴테이블\))?", _STEP["render3d"]),
    (r"턴테이블(?: 영상| 렌더(?!링))?", _STEP["render3d"]),
    (r"A[- ]?포즈", _STEP["apose"]),
    (r"3D 메시(?!지)", _STEP["mesh3d"]),
    (r"리깅(?=[된한할하해했됐되돼됩합됨함])", "뼈대 작업"),
    (r"리깅", _STEP["rig"]),
    (r"누끼", "배경 제거"),
    (r"숏츠", "쇼츠")))
# The state gives the agent a value and its word (genre, genreLabel): "SF 슈터(sf-shooter)" would read "SF 슈터(SF 슈터)"
_TWICE = re.compile("(" + "|".join(map(re.escape, sorted({*_SAID.values(), *(label for _, label in _OLD_WORDS)},
                                                         key=len, reverse=True)))
                    + r") ?\(\1\)" + _PARTICLE)
_PARTICLES = {"을": ("을", "를"), "를": ("을", "를"), "이": ("이", "가"), "가": ("이", "가"), "은": ("은", "는"),
              "는": ("은", "는"), "과": ("과", "와"), "와": ("과", "와"), "으로": ("으로", "로"), "로": ("으로", "로"),
              "이에요": ("이에요", "예요"), "예요": ("이에요", "예요")}


def _particle(label: str, particle: str) -> str:
    if not particle:
        return ""
    last = ord(label[-1]) - 0xAC00
    final = last % 28 if 0 <= last < 11172 else 0  # a Hangul syllable's final consonant (0 = none)
    if particle in ("으로", "로"):
        return "로" if final in (0, 8) else "으로"  # ㄹ takes 로
    return _PARTICLES[particle][0 if final else 1]


# The same in a reply written in English: a tool's name, a raw state value and the prompt's own words become the
# screen's English names (i18n.LABELS), a button or tab quoted by its Korean name gets its English one, and a name
# said twice ("Sci-fi shooter (Sci-fi shooter)") is said once.
_SAID_EN = {raw: i18n.LABELS.get(said, said) for raw, said in _SAID.items()}
_TOOL_NAME_EN = re.compile(r"`?(?<![A-Za-z0-9_])(" + "|".join(map(re.escape, sorted(_SAID, key=len, reverse=True)))
                           + r")(?![A-Za-z0-9_])(?:\(\))?`?")
_QUOTED_KO = re.compile(r"(['\"‘’“”])(" + "|".join(map(re.escape, sorted(
    (k for k in i18n.LABELS if re.search("[가-힣]", k)), key=len, reverse=True))) + r")(['\"‘’“”])")
_TWICE_EN = re.compile("(" + "|".join(map(re.escape, sorted({*_SAID_EN.values()}, key=len, reverse=True)))
                       + r") ?\(\1\)", re.I)


def _humanize_en(text: str) -> str:
    text = _TOOL_NAME_EN.sub(lambda m: _SAID_EN[m[1]], text)
    text = _QUOTED_KO.sub(lambda m: m[1] + i18n.LABELS[m[2]] + m[3], text)
    return _TWICE_EN.sub(lambda m: m[1], text)


def humanize_tools(text: str) -> str:
    """A reply with the agent's tool names, raw state values and the cards' older words replaced by the studio's
    words, the Korean particle after them fixed, and a name said twice said once. A reply written in English on an
    English page gets the screen's English names (_humanize_en)."""
    if i18n.lang() == "en" and i18n.is_english(text):
        return _humanize_en(text)
    text = _TOOL_NAME.sub(lambda m: _SAID[m[1]] + _particle(_SAID[m[1]], m[2] or ""), text)
    for old, label in _OLD_WORDS:
        text = old.sub(lambda m, label=label: label + _particle(label, m[1] or ""), text)
    return _TWICE.sub(lambda m: m[1] + _particle(m[1], m[2] or ""), text)


def _join(text: str, note: str) -> str:
    return f"{text}\n\n{note}" if text else note


def history(messages: list, pending_id: str) -> list:
    """Earlier chat as Converse turns: text only, empty answers dropped, same-role neighbours merged
    (Converse requires user/assistant alternation, starting with user)."""
    turns = []
    for m in messages:
        if m["messageId"] == pending_id:
            break
        text = (m.get("text") or "").strip()
        if not text:
            continue
        calls = [e.get("summary") for e in (m.get("toolEvents") or []) if e.get("summary")]
        if m["role"] == "assistant" and calls:  # the model must see which past answers really came from tools
            text = "[이 답변에서 실제로 실행한 도구: " + "; ".join(tools.clip(c, 200) for c in calls[:8]) + "]\n" + text
        if turns and turns[-1]["role"] == m["role"]:
            turns[-1]["content"][0]["text"] += "\n\n" + text
        else:
            turns.append({"role": m["role"], "content": [{"text": text}]})
    turns = turns[-HISTORY_MESSAGES:]
    while turns and turns[0]["role"] != "user":
        turns.pop(0)
    return turns


def kst(ts):
    """A stored UTC time ("2026-11-08T12:28:40.123Z") on the user's clock: "2026-11-08 21:28 KST"."""
    if not isinstance(ts, str) or not ts:
        return ts
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(KST).strftime("%Y-%m-%d %H:%M KST")


def in_flight(snap: dict) -> str:
    """One line of the unfinished jobs: "없음", or "2개: job_… shot 노바 (running), …"."""
    names = {ip["ipId"]: ip.get("name") for ip in snap["ips"]}
    running = [j for j in snap["jobs"] if j["status"] not in ("done", "failed")]
    if not running:
        return "없음"
    return f"{len(running)}개: " + ", ".join(
        " ".join(p for p in (j["jobId"], j["kind"], names.get(j["input"].get("ipId"))) if p) + f" ({j['status']})"
        for j in running)


def state_summary(snap: dict) -> str:
    """Compact JSON of what exists, so tool calls use real ids."""
    def keep(d):
        return {k: v for k, v in d.items() if v not in (None, "", [])}

    s = snap["session"]
    jobs_by_id = {j["jobId"]: j for j in snap["jobs"]}
    assets_by_id = {a["assetId"]: a for a in snap["assets"]}
    ips_by_id = {ip["ipId"]: ip for ip in snap["ips"]}
    images_by_key = {a["key"]: a for a in snap["assets"] if a.get("kind") == "image"}
    finished = ("done", "failed")
    glb_assets = {a["assetId"] for a in snap["assets"] if a.get("kind") == "glb"}
    held = tools.held_game(snap)
    return json.dumps({
        "지금 진행 중": in_flight(snap),  # first: the one line that outweighs old answers' progress
        "now": kst(store.now()),  # the time of this state (KST): older chat replies describe an earlier moment
        # genre is the id the tools take; genreLabel is what a reply calls it
        "session": {"sessionId": s["sessionId"], "title": s["title"], "genre": s["genre"],
                    "genreLabel": i18n.label(gamespec.GENRE_LABELS.get(s["genre"])),
                    "concept": s.get("concept")},  # concept null → "set_concept first"
        # the only jobs that may be called "진행 중": everything else is finished (done or failed)
        "jobsInFlight": [j["jobId"] for j in snap["jobs"] if j["status"] not in finished],
        # version: the IP's current picture (the card's vN), so "which one is used now" is never a guess
        "ips": [keep({**{k: ip.get(k) for k in ("ipId", "kind", "name", "role", "usage", "humanoid", "weaponType",
                                                "version", "turntableAssetId", "glbAssetId", "riggedGlbAssetId")},
                      # pending | updating | failed: the picture is still being drawn (or never came); absent = ready
                      "image": tools.image_state(ip, jobs_by_id),
                      # the look of the current picture (an edit that landed changed it): make_ip_variant rewrites it
                      "description": tools.current_description(ip, assets_by_id),
                      # a 3D model exists now (make_game shows the IP in 3D); false = it stands as its cutout
                      "has3d": bool({ip.get("glbAssetId"), ip.get("riggedGlbAssetId")} & glb_assets),
                      # make_game's 3D rule: ready (its 3D and rig are done) | running (3D still being made) | none
                      "game3d": tools.game_3d_state(ip, assets_by_id, jobs_by_id),
                      # refused: the rig tool cannot put a skeleton into this model (skeletonReason: why, in the
                      # user's words); the model is ready for a game as it is, and a retry fails the same way
                      **_skeleton(ip, assets_by_id, jobs_by_id)})
                for ip in snap["ips"]],
        "assets": [keep({k: a.get(k) for k in ("assetId", "kind", "ipId", "jobId")}) for a in snap["assets"]],
        "jobs": [keep({"jobId": j["jobId"], "kind": j["kind"], "status": j["status"],
                       # an image's check note says which picture its IP uses now, not when the draw was rejected
                       "ipId": j["input"].get("ipId"), "deps": j["deps"], "error": tools.job_note(j, ips_by_id),
                       # refused (with reason): its provider refused the work itself; a retry fails the same way
                       "outcome": j.get("outcome"), "reason": j.get("reason"),
                       # when its provider says it ended (jobs._finished_at), else when a poll settled it
                       **({"finishedAt": kst(j.get("finishedAt") or j.get("updatedAt"))} if j["status"] in finished
                          else {"progress": j.get("progress")}),
                       # an IP picture's draw: the version it drew and how its composition check went
                       **({"version": j["input"].get("version"), "check": _check(j, assets_by_id)}
                          if j["kind"] == "image" else {}),
                       # shots: what "[영상 수정 jobId=…]" re-makes with the change applied, and the look of the IP
                       # picture the shot was drawn from (an edit's prompt names what the shot shows)
                       **({**{k: j["input"].get(k) for k in ("prompt", "model", "seconds", "aspect_ratio", "lastIpId",
                                                             "edit", "task", "sourceShotJobId")},
                           "look": _shot_look(j, jobs_by_id, ips_by_id, images_by_key)}
                          if j["kind"] == "shot" else {})})
                 for j in snap["jobs"]],
        "games": [keep({k: g.get(k) for k in ("gameId", "title", "genre", "publishedUrl")}) for g in snap["games"]],
        # a game request waiting for 3D (hold_game_request): the page's 게임 만들기 sends it again once the 3D is ready.
        # ready: one of the IPs it waits for is ready for a game now (as the page offers it), so it can be made
        **({"heldGame": {"request": tools.clip(held["text"], 300), "ipIds": held["gameHeld"]["ipIds"],
                         "ready": tools.held_ready(held, ips_by_id, assets_by_id, jobs_by_id)}} if held else {}),
    }, ensure_ascii=False)


def _skeleton(ip, assets_by_id, jobs_by_id) -> dict:
    why = tools.refused_skeleton(ip, assets_by_id, jobs_by_id)
    return {"skeleton": jobs.REFUSED, "skeletonReason": why} if why else {}


def _job_facts(ctx, session_id: str, job_id: str) -> dict:
    """What a job a tool just registered will do: the unfinished jobs it waits for (empty = it starts now) and the
    existing assets it uses as they are (a trailer's turntable), so the reply states facts."""
    job = store.get_job(ctx, session_id, job_id)
    if not job:
        return {}
    waits = []
    for dep_id in job.get("deps") or []:
        dep = store.get_job(ctx, session_id, dep_id) or {}
        if dep.get("status") != "done":
            waits.append({"jobId": dep_id, "kind": dep.get("kind"), "status": dep.get("status")})
    facts = {"status": job["status"], "waitsFor": waits}
    if job["input"].get("extra_asset_ids"):
        facts["usesAssetIds"] = list(job["input"]["extra_asset_ids"])
    return facts


def _note_hold(ctx, session_id: str, asked, result: dict) -> bool:
    """Mark a game request that waits for 3D on the user message that asked for it (not on the session: it may not
    be the newest message): gameHeld {ipIds: the IPs whose 3D it waits for}, from the waiting3d that
    hold_game_request and a make_game refused with needs_3d answer. The page sends that message again once one of
    them is ready (web/src/api.ts heldGame); a game made after the message voids the mark. A hold that kept the
    request already on hold marks nothing. → whether the tool told a hold (marked now, or kept)."""
    waiting = [w["ipId"] for w in result.get("waiting3d") or [] if isinstance(w, dict) and isinstance(w.get("ipId"), str)]
    if asked and waiting and not result.get("kept"):
        store.update_message(ctx, session_id, asked, gameHeld={"ipIds": waiting})
    return bool(waiting)


# A game request the turn did not make.
# A reply can say a request is put aside without calling hold_game_request, so the turn keeps the hold itself
# (_keep_hold). The page offers the marked message as the held game and sends it again when the 3D lands
# (web/src/api.ts rebuildRequest), so a message that asked for no game must never be marked: the rule starts from
# what was asked and from the session, and reads the reply only for what those two cannot tell.

_SENTENCE = re.compile(r"[^.!?？\n]+[.!?？]*")  # a sentence with the marks that close it
_3D_ENDS = r"(?:끝나면|끝난\s*(?:뒤|다음)|끝나고|끝나는\s*대로|완료되면|준비되면|완성되면)"
# 게임 as the thing to be made: its particle, then at most a few words that say how many, how soon or with what.
# The cast only as "이 IP들로 / 이 캐릭터로 / 캐릭터들로": a bare "캐릭터로 / IP로" after 게임 is the thing asked for
# ("꼬마 마법사를 게임 캐릭터로 만들어줘").
_GAME_AS_OBJECT = (r"게임(?:을|를|은|는|도|까지|으로|로)?\s*(?:(?:하나만|하나|한\s*개|한\s*판|한\s*번|더|같이|함께|좀|새로|다시|바로|지금"
                   r"|이제|빨리|얼른|먼저|꼭|(?:이\s*(?:IP|캐릭터)들?|(?:IP|캐릭터)들)(?:으로|로)|3D(?:가)?\s*" + _3D_ENDS + r")\s*)*")
# The message asks to make a game ("게임 만들어줘", "게임을 만들고 싶어", "게임 제작해줘", or the held request's button
# as a line, "게임 만들기"). Not a thing of the game ("게임 배경 만들어줘"), not what comes before one ("게임 만들기 전에
# …"), not whether one is or can be made ("게임 만들 수 있어?"), nor a reason or something already done ("게임
# 만들어줘서 고마워").
_MAKE_ASKED = re.compile(_GAME_AS_OBJECT + r"(?:만들어(?!지|진|져|졌|도|야|줬|준|\s*줘서|\s*주셔서)|만들자|만들래|만들고\s*싶|만들기(?=\s*(?:$|[.!~]))"
                         r"|(?:제작|생성)(?:\s*해(?!도)|\s*하자|\s*부탁|(?=\s*(?:$|[.!~]))))")
# ... a question is a request only when it asks for the favour ("만들어 줄래?"), and never when it asks how or when
_FAVOUR = re.compile(r"(?:만들어|제작해|생성해)\s*(?:줄|주|줘|드릴|드려)")
_ASKS_HOW = re.compile(r"어떻게|어떡|언제|왜|뭐|뭘|무엇|무슨|어떤|어느|어디|얼마|방법")
# The message says to leave the game unmade ("게임은 아직 만들지 마", "게임 말고 영상") or takes a request back
# ("게임 요청 취소해줘")
_NO_GAME = re.compile(r"게임(?:을|를|은|는|도)?\s*(?:(?:아직|지금은|일단|당장은|이번에는|이번엔)\s*)*"
                      r"(?:(?:만들|제작하|생성하)지\s*(?:는\s*|도\s*)?(?:마|말|않)|말고|빼고|필요\s*없|안\s*만들어도)"
                      r"|(?:게임|요청)[^.!?？\n]{0,20}취소")


# The same readings of a message written in English (the markers the page sends stay Korean): "make a game", "build
# me a zombie survival game", "turn this into a game", "I want a racing game", "game please", or the held request's
# button as a line ("Make game"). The game must be the thing asked for:
#  - a game, not a word built on it ("game-ready", "in-game") and not a thing of it ("a game character / trailer":
#    _GAME_THING), nor a board or card game's piece;
#  - a game to be MADE, not the one that exists made otherwise: after "the / this / my game" only what a request
#    goes on with ("make the game now", "… when the 3D is done": _GOES_ON); "make the game harder" is an edit;
#  - asked for, not spoken of: not what comes before one, not something already done, not whether or how one is
#    made ("can I make a game?"), not liked ("I love the game").
# A genre's own noun stands for the game ("make an RPG"); "a shooter" and "a racer" can be characters and are left
# to the reply.
_GAME_EN = (r"(?:games?|platformers?|roguelikes?|j?rpgs?|metroidvanias?|hack[- ]and[- ]slash(?:er)?"
            r"|(?:space|sci-fi|sf|arena|top-down|twin-stick|first-person|third-person)\s+shooters?)")
_GAME_THING = (r"(?!\s*(?:design|trailer|background|backdrop|asset|character|enem(?:y|ies)|prop|weapon|art|icon|logo|title"
               r"|music|sound|soundtrack|sfx|pane|tab|spec|request|file|server|window|ad|piece|board|model|mode|level"
               r"|map|scene|world|hero|heroine|boss|villain|monster|npc|item|object|ui|hud|menu|engine|mechanic|rule"
               r"|setting|idea|concept|name|cover|poster|thumbnail|screenshot|video|clip|footage|page|link|url|card"
               r"|button|over|jam|studio|dev|developer|console|controller|store|shop|plan|loop|logic|code|version"
               r"|session|ready|screen|text|font|sprite|texture|skin|theme|style|genre|environment|stage|mascot"
               r"|state|score|token|doc|document|brief|pitch|script|story|plot|lore|intro|outro|ending|cutscene"
               r"|effect|preview|pack|kit|cabinet|machine|cartridge)s?\b)")
# The words between the verb and the game: no preposition (the game is then no object: "make an enemy for the
# game"), no second game and no other verb ("make a game trailer and publish the game")
_BETWEEN = (r"(?:\s+(?!(?:for|in|into|of|to|with|from|inside|before|after|until|when|once|if|about|on|at|sure|games?"
            r"|publish|delete|edit|fix|change|update|play|open|show|share|remove|rename|test|check|watch|is|are|was"
            r"|be)\b)[\w'’-]+){0,6}?")
_MAKE_ASKED_EN = re.compile(
    r"\b(?:(?P<want>(?:i|we)\s+(?:want|need)|(?:i|we)(?:['’]d|\s+would)\s+(?:like|love))"
    r"(?:\s+to\s+(?:make|build|create|have|get|(?P<play>play|see|try)))?"
    r"|make|build|create|generate|produce|craft|whip\s+up|put\s+together|give\s+(?:me|us)|get\s+(?:me|us)"
    r"|(?:can|could|may)\s+(?:i|we)\s+(?:get|have)|let['’]?s\s+do)"
    r"(?P<between>" + _BETWEEN + r")\s+" + _GAME_EN + r"\b(?![-'’])" + _GAME_THING + r"(?P<tail>[^\n]*)", re.I)
_INTO_EN = re.compile(r"\b(?:turn|make|convert)\b[^.!?\n]{0,40}\binto\s+(?:a|an|the)\s+(?:(?!games?\b)[\w'’-]+\s+){0,4}?"
                      + _GAME_EN + r"\b(?![-'’])" + _GAME_THING, re.I)
# ... with no verb ("game please", "another game, 60 seconds this time"), or the held request's button as a line
_BARE_EN = re.compile(
    r"^\s*(?:(?:ok(?:ay)?|alright|and|so|yes|yep|sure|great|cool|perfect)[,!]?\s+)*(?:"
    r"(?:(?:a|an|the)\s+)?(?:[\w-]+\s+){0,2}?game[,]?\s+(?:please|pls|now|next|time)\b"
    r"|(?:another|one\s+more|a\s+new|a\s+second)\s+(?:[\w-]+\s+){0,3}?game\s*(?:$|[,.!]|please|pls|now|too|with|but)"
    r"|(?:now|next|then)[,]?\s+(?:for\s+)?(?:a|the)\s+(?:[\w-]+\s+){0,2}?game\s*[.!]*\s*$"
    r"|make game\s*[.!]?\s*$)", re.I)
_DEFINITE_EN = re.compile(r"\b(?:the|this|that|my|our|your|his|her|its|their)\b", re.I)
_INDEFINITE_EN = re.compile(r"\b(?:a|an|another|one|some|new)\b", re.I)
# What a request goes on with after "the game" (anything else there says how the game is to be: an edit)
_GOES_ON = re.compile(r"\s*(?:$|[,;:.!?)\]—–]|(?:now|please|pls|again|too|already|today|tonight|first|next|right|with"
                      r"|using|from|when|once|after|as\s+soon|if|and|then|so|for\s+(?:me|us))\b)", re.I)
# A board or card game is no game of the studio's; its piece or card is a prop
_TABLETOP = re.compile(r"\b(?:board|card|tabletop|dice|trading)\s*$", re.I)
# "to make a game" is a request only after a wish ("I want to …", "I need you to …", "time to …")
_WISH_TO = re.compile(r"\b(?:want|wanna|like|love|need|wish|hope|going|ready|time|ask(?:ing)?)(?:\s+(?:you|us))?\s+to\s*$", re.I)
_TO = re.compile(r"\bto\s*$", re.I)
# "you didn't make the game", "I can't make a game": said of a game, not asked; nor the button as a thing pressed
_NOT_BEFORE_EN = re.compile(r"(?:\bnot|n['’]t|\bnever|\bcannot)\s+(?:[\w'’]+\s+){0,2}$"
                            r"|\b(?:press|click|tap|push|hit|us)(?:e|ed|ped|ing)?\s+(?:on\s+)?$", re.I)


def _makes_game_en(s: str) -> bool:
    """An English sentence asks for a game to be made (the readings above)."""
    if _BARE_EN.search(s) or _INTO_EN.search(s):
        return True
    at = 0
    while True:
        m = _MAKE_ASKED_EN.search(s, at)
        if not m:
            return False
        at = m.start() + 1
        before, between, tail = s[:m.start()], m["between"] or "", m["tail"]
        if _NOT_BEFORE_EN.search(before) or _TABLETOP.search(between):
            continue
        if not m["want"] and _TO.search(before) and not _WISH_TO.search(before):
            continue
        determiners = [d for d in re.finditer(r"[\w'’-]+", between)
                       if _DEFINITE_EN.fullmatch(d[0]) or _INDEFINITE_EN.fullmatch(d[0])]
        definite = bool(determiners) and bool(_DEFINITE_EN.fullmatch(determiners[-1][0]))
        if definite and (m["play"] or not _GOES_ON.match(tail)):
            continue  # the game that exists: played, or made otherwise
        return True


# ... a question is a request only when it asks for the favour ("can you make a game?", "could you please build …")
_FAVOUR_EN = re.compile(r"\b(?:can|could|would|will)\s+you\b|\bplease\b|\bshall we\b|\b(?:can|could|may)\s+(?:i|we)\s+(?:get|have)\b",
                        re.I)
_ASKS_HOW_EN = re.compile(r"^\s*(?:and\s+|so\s+|but\s+)?(?:how|when|why|what|which|where|who|is|are|was|were|did|does|do"
                          r"|has|have|should)\b|\bhow\s+(?:do|can|could|to|long|much|many|soon)\b"
                          r"|\bwhen\s+(?:will|can|do|does|is)\b|\bwhat\s+(?:do|can|should)\b", re.I)
_BEFORE_EN = re.compile(r"\b(?:before|until|after|thanks?(?: you)? for|since you)\b[^.!?\n]{0,25}"
                        r"\b(?:mak|build|creat|generat)\w*\b[^.!?\n]{0,30}\bgame\b", re.I)
# The message says to leave the game unmade ("don't make the game yet", "a video instead of a game") or takes a
# request back ("cancel the game request"). "Why don't we make a game?" is a question, not this.
_NO_GAME_EN = re.compile(
    r"(?<!why )\b(?:don'?t|don’t|do not|never|no need to|not going to|needn'?t)\b(?!\s+know\b)[^.!?\n]{0,25}\b(?:make|build|create|generate)\b"
    r"[^.!?\n]{0,25}\bgame\b"
    r"|\b(?:don'?t|don’t|do not|doesn'?t|doesn’t)\s+(?:want|need)\b[^.!?\n]{0,25}\bgame\b"
    r"|\b(?:no|without(?:\s+(?:a|the))?|instead of(?:\s+(?:a|the))?|rather than(?:\s+(?:a|the))?|skip(?:\s+the)?"
    r"|hold off on(?:\s+the)?|not\s+(?:a|the))\s+game\b"
    r"|\bgame\b[^.!?\n]{0,20}\b(?:is not|isn'?t|isn’t|not)\s+needed\b"
    r"|\b(?:cancel|scrap|drop|forget)\b[^.!?\n]{0,25}\b(?:game|request)\b", re.I)
# ... nor a game for another time ("make the game later"), nor the free text of an edit the page sent (its marker
# stays Korean: "[게임 수정 gameId=…] make the enemies faster and rebuild the game")
_LATER_EN = re.compile(r"\b(?:later|afterwards?|another time|some other time|not now)\b", re.I)
_EDIT_MARK = re.compile(r"\[(?:게임 수정|에셋 수정|영상 수정)\b")
_GAME_WORD = re.compile(r"게임|\b" + _GAME_EN + r"\b", re.I)


def _asks_game(asked: dict):
    """Whether the user's message is a game request. True: it asks to make a game (it carries a 게임 설계, or says
    so); None: it speaks of a game without asking to make one; False: no word of a game, or it says to leave the
    game unmade."""
    if asked.get("gameDesign"):
        return True
    said = [s for s in _SENTENCE.findall(asked.get("text") or "") if _GAME_WORD.search(s)]
    if not said or any(_NO_GAME.search(s) or _NO_GAME_EN.search(s) for s in said):
        return False
    edit = bool(_EDIT_MARK.search(asked.get("text") or ""))

    def asks(s):
        question = s.rstrip().endswith(("?", "？"))
        if _MAKE_ASKED.search(s) and not _ASKS_HOW.search(s) and (not question or bool(_FAVOUR.search(s))):
            return True
        return (not edit and _makes_game_en(s) and not _BEFORE_EN.search(s) and not _LATER_EN.search(s)
                and not _ASKS_HOW_EN.search(s) and (not question or bool(_FAVOUR_EN.search(s))))
    return True if any(asks(s) for s in said) else None


_QUOTE = "['\"‘’“”]"
_PUT_ASIDE = r"(?:두었|뒀|놓았|놨|둘게|놓을게|두겠|드렸|드릴게)"
# The reply says, of this turn's request, that it is put aside ("게임 요청은 보류해 두었습니다"). Not the rule as told
# to someone who asked how it works ("요청하면 그 요청을 보류해 둬요"), not a hold that already stood and not a 3D
# that was queued ("3D를 걸어 두었습니다").
_HELD_SAID = re.compile(
    r"(?:요청(?:을|를|은|는|도|이|가)?|게임(?:을|를|은|는|도))\s*"
    r"(?:(?:잠시|잠깐|일단|우선|먼저|아직|지금은|이번에는|그대로|따로|당분간|그때까지|3D가\s*(?:끝날|준비될|완성될)\s*때까지)\s*)*"
    r"(?:보류(?:해|하여)?\s*" + _PUT_ASIDE + r"|보류(?:했|할게|하겠|됐|되었|시켰)|보류\s*(?:중|상태)(?:이에요|예요|입니다)"
    r"|미뤄\s*" + _PUT_ASIDE + r"|미뤘|미룰게|미루겠"
    r"|대기(?:시켜|해)\s*" + _PUT_ASIDE + r"|대기시켰|대기\s*(?:중|상태)(?:이에요|예요|입니다)"
    r"|기억해\s*" + _PUT_ASIDE
    + r"|(?:보류할|보류해\s*둘|미룰|미뤄\s*둘)\s*수밖에\s*없)")
_IF_ASKED = re.compile(r"(?:요청|말씀?|부탁)(?:을|를)?\s*\S{0,4}면|경우")  # "게임을 요청하면 …": how it works
# The reply says nothing is held ("보류해 둔 게임 요청은 없어요"), asks whether to hold ("보류해 둘까요?"), or says the
# game exists
_NOT_HELD = re.compile(r"(?:보류|미뤄|미루|미룰)[^.!?？\n]{0,40}?(?:없|않|아니|안\s*했|못\s*했)"
                       r"|(?:보류|미뤄|미루|미룰)[^.!\n]{0,40}[?？]")
_MADE_SAID = re.compile(r"게임\s*(?:[\"“‘'「『][^\"”’'」』\n]{1,60}[\"”’'」』])?\s*(?:을|를|이|은|도)?\s*"
                        r"(?:(?:이미|방금|새로|다시|새\s*버전으로|같은\s*구성으로)\s*)*(?:만들었|만들어졌"
                        r"|만들어\s*(?:두었|뒀|놓았|놨|드렸)|완성(?:했|됐|되었))|(?:이미|아까|방금|전에)\s*만든\s*게임")
# Under a message that asks to make a game, a reply also tells a hold when it says a button will bring the game once
# the 3D is in (the held request's button named as a button, or a button it does not name), or promises the game for
# then ("3D가 끝나면 … 게임을 만들겠습니다"). Under any other message these are what a plain 3D request is answered
# with.
_BUTTON_SAID = re.compile(_QUOTE + re.escape(tools.HELD_BUTTON) + _QUOTE + "|" + re.escape(tools.HELD_BUTTON) + r"\s*버튼"
                          r"|버튼(?:이|도)?\s*(?:나타나|나타납|나타날|나와요|나옵|나올|생겨|생깁|생길|떠요|뜹니다|보여요|보입|보일)")
_WILL_MAKE = r"(?:만들겠|만들게요|만들어\s*드릴|만들\s*예정|만들어\s*둘)"
_LATER_SAID = re.compile(r"3D[^.\n]{0,40}" + _3D_ENDS + r"[^.\n]{0,60}게임[^.\n]{0,30}" + _WILL_MAKE
                         + r"|게임[^.\n]{0,30}3D[^.\n]{0,40}" + _3D_ENDS + r"[^.\n]{0,30}" + _WILL_MAKE)
# The reply says the game was refused for something that is not 3D: the user is to ask again once the picture is
# there (make_game's images_pending). A reply that only says the pictures are being drawn refuses nothing.
_OTHER_REASON = re.compile(r"(?:그림|이미지)[^.!?？\n]{0,30}(?:나오면|나타나면|끝나면|완성되면|준비되면)[^.!?？\n]{0,20}"
                           r"다시\s*(?:요청|말|보내|시도)")


# The same readings of a reply written in English. Put aside: "I've put your game request on hold", "the game is
# waiting for the 3D", "I've saved / kept / noted / paused your request", "your request is queued behind the 3D".
# Not the rule as told ("if you ask for a game I put the request on hold"), not a hold that already stood and not a
# 3D that was queued. Saved, kept, noted and queued count only when said of the REQUEST ("the picture is saved" is
# no hold).
_HELD = r"(?:on hold|put aside|set aside|held(?!\s+(?:by|in|up))|parked|saved for later|waiting\s+(?:for|on|until)\b[^.!?\n]{0,30}\b3D)"
_KEPT = r"(?:saved|kept|noted|paused|queued|parked|stored|recorded|remembered|shelved|deferred|postponed)"
# A request of another kind is no game request ("the trailer request is queued")
_REQUEST = r"(?<!trailer )(?<!picture )(?<!image )(?<!video )(?<!3D )(?<!edit )(?<!shot )(?<!redraw )(?<!rig )request"
_ASKED = r"(?:" + _REQUEST + r"|game)"
_I = r"\b(?:i|we)(?:'ve|’ve| have|'ll|’ll| will)?\s+(?:just\s+|now\s+)?"
_YOUR = r"(?:your|the|this|that)\s+(?:game\s+)?"
_HELD_SAID_EN = re.compile(
    r"\b" + _ASKED + r"\b[^.!?\n]{0,40}?\b(?:is|was|has been|stays|remains|will be|will stay|will wait)\s+(?:now\s+|still\s+)?" + _HELD
    + r"|\b" + _ASKED + r"(?:'s|’s)\s+(?:now\s+|still\s+)?" + _HELD
    + "|" + _I + r"(?:put|placed|kept|set|parked|saved|am keeping|am holding|'m holding)"
      r"\b[^.!?\n]{0,40}?\b(?:" + _REQUEST + r"|game|it)\b[^.!?\n]{0,30}?\b(?:on hold|aside|for later)\b"
    + "|" + _I + r"(?:held|hold|holding)\s+(?:on to\s+)?" + _YOUR + _ASKED + r"\b"
    + r"|\bholding\s+(?:on to\s+)?" + _YOUR + _ASKED + r"\b"
    + r"|\bput\s+a\s+hold\s+on\s+" + _YOUR + _ASKED + r"\b"
    + r"|\b" + _REQUEST + r"\b[^.!?\n]{0,25}?\b(?:is|was|has been|stays|remains|will be)\s+(?:now\s+|still\s+)?" + _KEPT + r"\b"
    + "|" + _I + r"(?:" + _KEPT + r"|keep|save|note|pause|queue|park|remember)\s+" + _YOUR + _REQUEST + r"\b"
    + "|" + _I + r"(?:deferred|postponed|defer|postpone)\s+" + _YOUR + _ASKED + r"\b"
    + r"|\b" + _REQUEST + r"\b[^.!?\n]{0,15}\bwaits?\s+(?:for|until|on)\b"
    + r"|\bhold(?:ing)?\s+off\s+on\s+(?:(?:making|building|creating)\s+)?(?:your|the|this|that)\s+" + _ASKED + r"\b", re.I)
_IF_ASKED_EN = re.compile(r"\b(?:if|when|whenever)\s+you\s+(?:ask|request)|\bin (?:that|which) case\b", re.I)
_HOLD_WORD = r"(?:on hold|held|hold|put aside|set aside|holding|" + _KEPT + r")"
# Nothing is held ("no game request is on hold"), or the reply offers to hold ("shall I put the request on hold?").
# A question about a hold ("is the request still on hold?") says neither.
_NOT_HELD_EN = re.compile(
    r"\b(?:no|not|nothing|isn'?t|isn’t|wasn'?t|wasn’t|aren'?t|haven'?t|haven’t|hasn'?t|didn'?t|didn’t|don'?t|don’t|never)\b"
    r"[^.!?\n]{0,40}\b" + _HOLD_WORD + r"\b"
    r"|\b(?:shall|should)\s+(?:i|we)\b[^.!\n]{0,40}\b" + _HOLD_WORD + r"\b[^.!\n]{0,40}\?"
    r"|\b(?:want|like)\s+me\s+to\b[^.!\n]{0,40}\b" + _HOLD_WORD + r"\b[^.!\n]{0,40}\?", re.I)
_NOT_YET = r"(?:(?!3D|\b(?:when|once|until|after|if|as soon as|before)\b)[^.!?\n]){0,50}?"
_MADE_SAID_EN = re.compile(
    r"(?<!n't )(?<!n’t )(?<!not )(?<!never )\b(?:made|built|created|remade|rebuilt|finished)\b" + _BETWEEN
    + r"\s+game\b(?![-'’])" + _GAME_THING
    + r"|\bgame\b" + _NOT_YET + r"\b(?:is|has been|was)\s+(?:now\s+|already\s+)?(?:ready|made|built|created|done|finished)\b"
    + r"|\bgame(?:'s|’s)\s+(?:now\s+)?(?:ready|made|done)\b", re.I)
_3D_ENDS_EN = r"\b(?:once|when|after|as soon as)\b[^.\n]{0,40}\b(?:3D|rig)\b"
_WILL_MAKE_EN = r"(?:\b(?:i|we)(?:'ll|’ll| will)\s+(?:then\s+)?(?:make|build|create)\b|\bwill be (?:made|built|created)\b)"
# The held request's button, named: its label quoted or as "the Make game button", or a button said to make the
# game. Any other button ("a Download button appears …") is not it.
_MAKE_GAME_EN = re.escape(i18n.LABELS[tools.HELD_BUTTON])
_BUTTON_SAID_EN = re.compile(
    _QUOTE + _MAKE_GAME_EN + _QUOTE + "|" + _MAKE_GAME_EN + r"\s+button"
    r"|\bbutton\b[^.!?\n]{0,12}\b(?:to|that|which)\s+(?:makes?|builds?|creates?)\s+(?:the|your|a)\s+game\b", re.I)
_LATER_SAID_EN = re.compile(
    _3D_ENDS_EN + r"[^.\n]{0,60}" + _WILL_MAKE_EN + r"[^.\n]{0,30}\bgame\b"
    + "|" + _3D_ENDS_EN + r"[^.\n]{0,60}\bgame\b[^.\n]{0,20}\bwill be (?:made|built|created)\b"
    + "|" + _WILL_MAKE_EN + r"[^.\n]{0,30}\bgame\b[^.\n]{0,30}" + _3D_ENDS_EN
    + r"|\bgame\b[^.\n]{0,20}\bwill be (?:made|built|created)\b[^.\n]{0,40}" + _3D_ENDS_EN
    + r"|\bgame\b[^.!?\n]{0,15}\b(?:comes?|follows?|will follow|will come|is)\s+(?:right\s+|straight\s+|soon\s+|just\s+)?"
      r"(?:after|next)\b", re.I)
_OTHER_REASON_EN = re.compile(
    r"\b(?:picture|image|drawing)s?\b[^.!?\n]{0,40}\b(?:appears?|shows? up|ready|done|finished|lands?|drawn)\b[^.!?\n]{0,30}"
    r"\b(?:ask|request|send|try)\b[^.!?\n]{0,15}\bagain\b"
    r"|\b(?:ask|request|send|try)\b[^.!?\n]{0,15}\bagain\b[^.!?\n]{0,30}\b(?:picture|image|drawing)s?\b", re.I)


def _made_said(text: str) -> bool:
    """The reply says the game exists (in Korean or in English)."""
    return bool(_MADE_SAID.search(text) or _MADE_SAID_EN.search(text))


def _says_hold(text: str, clear: bool):
    """What the reply says of a hold. True: this turn's request is put aside: said outright, or, under a message
    that asks to make a game (clear), by a button or a game promised for when the 3D ends. False: nothing is held,
    or the game was made. None: neither."""
    for sentence in _SENTENCE.findall(text):
        for held, if_asked in ((_HELD_SAID, _IF_ASKED), (_HELD_SAID_EN, _IF_ASKED_EN)):
            said = held.search(sentence)
            # in English the "not" stands in the same sentence: "no game request is on hold"
            denied = held is _HELD_SAID_EN and _NOT_HELD_EN.search(sentence)
            if (said and not denied and not sentence.rstrip().endswith(("?", "？"))
                    and not if_asked.search(sentence[:said.start()])):
                return True
    if _NOT_HELD.search(text) or _NOT_HELD_EN.search(text) or _made_said(text):
        return False
    promised = (_BUTTON_SAID.search(text) or _LATER_SAID.search(text)
                or _BUTTON_SAID_EN.search(text) or _LATER_SAID_EN.search(text))
    return True if clear and promised else None


def _keep_hold(ctx, session_id: str, asked, text: str, turn: dict) -> None:
    """Keep a game request the turn did not make on record while it waits for 3D: the user message is marked as
    hold_game_request would mark it (gameHeld). Never when the turn made a game, when a tool told a hold, or when a
    request is on hold already. Only a game request is marked (_asks_game):
     - it asks to make a game and make_game's 3D rule would refuse it now (tools.hold_heroes, sure): on hold whatever
       the reply says, unless the reply says the game was made or it was refused for another reason;
     - else the reply decides (_says_hold): the request then waits for the heroes whose 3D is not ready, or, with
       every hero ready, for the cast whose 3D is not (tools.hold_cast)."""
    if not asked or turn["made"] or turn["held"]:
        return
    clear = _asks_game(asked)
    if clear is False:
        return
    said = _says_hold(text, bool(clear))
    # The re-make button, which older replies name for a held request: a promise of a hold only in a session
    # without a game; with one it is the offer to re-make that game, which a mark would silence (web/src/api.ts)
    remake = bool(clear) and said is None and (tools.REMAKE_BUTTON in text
                                               or i18n.LABELS[tools.REMAKE_BUTTON].lower() in text.lower())
    if not (said or clear):
        return
    try:
        snap = store.snapshot(ctx, session_id)  # after this turn's tools: a 3D chain it queued counts as running
        if tools.held_game(snap):
            return
        if said or (remake and not snap["games"]):
            waiting = tools.hold_heroes(snap, asked, text) or tools.hold_cast(snap, asked, text)
        elif clear and not (turn["refused"] or _made_said(text) or _OTHER_REASON.search(text)
                            or _OTHER_REASON_EN.search(text)):
            waiting = tools.hold_heroes(snap, asked, text, sure=True)
        else:
            waiting = []
        if waiting:
            store.update_message(ctx, session_id, asked, gameHeld={"ipIds": waiting})
    except Exception:  # noqa: BLE001 — the reply still lands; its hold is then in its words alone
        traceback.print_exc()


def _shot_look(job, jobs_by_id, ips_by_id, images_by_key) -> str:
    """What the IP in a shot looks like: the words of the IP picture the shot was drawn from (its action still's first
    reference, else its first frame), through the shot an edit re-makes; "" for a shot of no IP. The IP may show
    another version by now, so an edit's prompt must take the look from here."""
    for _ in range(8):  # an edit of an edit ...
        source = jobs_by_id.get(job["input"].get("sourceShotJobId") or "")
        if not source:
            break
        job = source
    still = jobs_by_id.get(job["input"].get("stillJobId") or "")
    key = (still["input"].get("references") or [None])[0] if still else job["input"].get("imageKey")
    image = images_by_key.get(key)
    ip = ips_by_id.get((image or {}).get("ipId"))
    return tools.description_of(ip, image) if ip else ""


def _check(job, assets_by_id):
    """The composition check of the picture an image job saved: "ok" | "failed" (its error says what failed), or None
    (not saved yet or never, or not checked: a background, a refused background removal, an action still)."""
    image = next((assets_by_id[a] for a in job.get("outputs") or []
                  if (assets_by_id.get(a) or {}).get("kind") == "image"), None)
    check = ((image or {}).get("meta") or {}).get("check")
    return ("ok" if check.get("ok") else "failed") if check else None


def fail_stale_turns(ctx, snap: dict) -> None:
    """Safety net for turns whose Lambda died (timeout, crash, lost async event): fail them, in place."""
    for m in snap["messages"]:
        if m["status"] == "pending" and store.age_sec(m["ts"]) > STALE_TURN_SEC:
            store.update_message(ctx, snap["session"]["sessionId"], m, status="failed",
                                 text=tr("응답이 너무 오래 걸려 중단됐어요. 다시 요청해 주세요."))


# ── a chain of jobs a turn or a card's button started tells the chat when it has ended ──
# The turn marks the last job of the chain it registered with the chain's job ids (watch), and the session's poll
# says once, when all of them have ended, what is ready and where to look (tell_finished). A card button's route
# marks its chain the same way (app.run_tool). The genre skills' plan (make_skill_asset) is no such chain: its
# drawer follows it.

# The tools whose jobs run on for minutes after the reply, and the keys of their result that hold the chain's jobs
# (the last one named is the one marked)
CHAINS = {"render_3d": ("poseJobId", "meshJobId", "jobId", "rigJobId"), "cut_trailer": ("jobId",)}
WATCHED, TOLD = "wait", "said"  # job.notify
FAILED_WHERE = "‘작업 현황’ 탭에서 이유와 다음에 할 일을 볼 수 있어요."


def watch(ctx, session_id: str, tool: str, result: dict) -> None:
    """Mark the chain a tool's result registered (CHAINS), for tell_finished. Nothing for a refusal or another tool."""
    chain = [result[k] for k in CHAINS.get(tool, ()) if isinstance(result.get(k), str)]
    if chain and "error" not in result:
        # with the language of the request that started it, where that is not Korean: the line is written later,
        # by whichever page polls or after the minute tick
        store.update_job(ctx, session_id, chain[-1], notify=WATCHED, chain=chain,
                         **({"lang": i18n.lang()} if i18n.lang() != "ko" else {}))


def tell_finished(ctx, snap: dict) -> None:
    """Called from the session's poll: add one chat line for each watched chain whose jobs have all ended (to snap
    too, so this poll answers with it). Said once: the mark is taken first and only from its own value, so an
    overlapping poll says nothing. Never in the way of the poll."""
    try:
        sid, by_id = snap["session"]["sessionId"], {j["jobId"]: j for j in snap["jobs"]}
        for last in snap["jobs"]:
            chain = [by_id[i] for i in last.get("chain") or [] if i in by_id] if last.get("notify") == WATCHED else []
            if not chain or any(j["status"] not in ("done", "failed") for j in chain):
                continue
            if not store.update_job(ctx, sid, last["jobId"], expect={"notify": WATCHED}, notify=TOLD):
                continue
            last["notify"] = TOLD
            with i18n.speaking(last.get("lang")):  # not the polling page's language: the chain's own (watch)
                line = _finished(snap, chain)
            if line:
                snap["messages"].append(store.put_message(ctx, sid, "assistant", line, "done", ts=_ended_at(snap, chain)))
    except Exception:  # noqa: BLE001
        traceback.print_exc()


def _ended_at(snap: dict, chain: list) -> str:
    """The time the chain's line carries: when its last job finished (the provider's own end, else the job's last
    write), not the poll that writes the line. Never later than now, and always after the request that started the
    chain and after every message the chat holds, so the line stays the chat's last."""
    ended = min(max(j.get("finishedAt") or j.get("updatedAt") or "" for j in chain), store.now())
    floor = max([m["ts"] for m in snap["messages"]] + [j.get("createdAt") or "" for j in chain])
    if ended > floor:
        return ended
    t = datetime.fromisoformat(floor.replace("Z", "+00:00")) + timedelta(milliseconds=1)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"  # like store.now()


def _finished(snap: dict, chain: list) -> str:
    """What the chat says of a chain that has ended: what is ready and where to look, or what is not and where its
    reason is. "" for one the user stopped (the 중지 button said so)."""
    by_id = {j["jobId"]: j for j in snap["jobs"]}
    failed = [j for j in chain if j["status"] == "failed"]
    waited = [by_id.get(d) or {} for j in failed for d in j.get("deps") or []]  # e.g. a trailer's shots
    if any(j.get("error") == jobs.CANCELED for j in [*failed, *waited]):
        return ""
    last = chain[-1]
    if last["kind"] == "trailer":
        if failed:
            return tr("트레일러를 만들지 못했어요. {where}", where=tr(FAILED_WHERE))
        return (tr("트레일러와 쇼츠가 완성됐어요. ‘영상’ 탭에서 볼 수 있어요.") if last["input"].get("make_shorts")
                else tr("트레일러가 완성됐어요. ‘영상’ 탭에서 볼 수 있어요."))
    ip = next((i for i in snap["ips"] if i["ipId"] == last["input"].get("ipId")), None) or {}
    name = ip.get("name") or "IP"
    button, mesh = i18n.label(tools.HELD_BUTTON), i18n.label(_STEP["mesh3d"])
    held = tools.held_game(snap)  # a game request that waited for this 3D: the page shows its button once it is ready
    offered = bool(held and ip.get("ipId") in (held["gameHeld"].get("ipIds") or []) and tools.offered_3d(
        ip, {a["assetId"]: a for a in snap["assets"]}, by_id))
    if failed:
        root = next((j for j in failed if j.get("error") != jobs.DEP_FAILED), None)  # the step that failed by itself
        if (root or {}).get("outcome") == jobs.REFUSED:
            # The rig tool refused the figure: the model stays as it is and a retry fails the same way, so the line
            # says what can be done with it and never "다시 시도"
            game = (tr("요청해 둔 게임은 ‘{button}’ 버튼으로 지금 만들 수 있고, 걷는 동작 없이 나와요.", button=button) if offered
                    else tr("이대로 게임을 만들면 걷는 동작 없이 나와요."))
            # the reason is the job's own, Korean in storage for the web to read: its English is the table's
            return tr("{name}의 {mesh_un} 준비됐지만 {rig_un} 넣지 못했어요: {reason}. {game} {redraw}", name=name,
                      mesh=mesh, mesh_un=waits.josa(_STEP["mesh3d"], "은", "는"), rig=i18n.label(_STEP["rig"]),
                      rig_un=waits.josa(_STEP["rig"], "은", "는"), reason=i18n.data(root.get("reason") or rig.OTHER_REASON),
                      game=game, redraw=tr(rig.REDRAW_FORM, needs=tr(rig.PICTURE_NEEDS)))
        step = _STEP.get((root or {}).get("kind"))
        if step and any(j["kind"] == "mesh3d" and j["status"] == "done" for j in chain):
            return tr("{name}의 {mesh_un} 준비됐지만 {step} 단계가 실패했어요. {where}", name=name, mesh=mesh,
                      mesh_un=waits.josa(_STEP["mesh3d"], "은", "는"), step=i18n.label(step), where=tr(FAILED_WHERE))
        if step:
            return tr("{name}의 3D를 만들지 못했어요({step} 단계에서 실패). {where}", name=name, step=i18n.label(step),
                      where=tr(FAILED_WHERE))
        return tr("{name}의 3D를 만들지 못했어요. {where}", name=name, where=tr(FAILED_WHERE))
    line = tr("{name}의 3D가 준비됐어요. ‘3D’ 탭에서 돌려 볼 수 있어요.", name=name)
    if offered:
        line += " " + tr("요청해 둔 게임은 ‘{button}’ 버튼으로 만들 수 있어요.", button=button)
    return line
