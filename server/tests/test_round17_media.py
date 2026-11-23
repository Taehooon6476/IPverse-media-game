"""A landed edit saves the IP's description after the change on its image, and shots read the description of the IP's
current picture (else a still's prompt contradicts its reference). Also: one ETA for a promoted model's edit, and
progress lines and replies in the user's words."""
from server import agent, store, tools
from server.tests.test_mediagen_image import _run, box, ctx, session  # noqa: F401 (fixtures)

V1 = ("young human male explorer wearing a copper-colored full-face mask helmet, brown travel cloak, leather gloves, "
      "sturdy boots")
NAVY = V1.replace("brown travel cloak", "navy blue travel cloak")


def _hero(ctx, session):
    out = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "character", "name": "카이로", "description": V1})
    _run(ctx, session)
    return out["ipId"]


def _still_prompt(ctx, session, ip_id):
    out = tools.run_tool(ctx, session, "make_action_shot", {"ipId": ip_id, "action": "sprinting over dunes"})
    job = store.get_job(ctx, session["sessionId"], out["stillJobId"])
    return job["input"]["prompt"]


def _edit(ctx, session, ip_id, **args):
    out = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": ip_id, "prompt": "change the cloak to navy blue", **args})
    _run(ctx, session)
    return out


def test_the_action_still_describes_the_edited_version_the_agent_rewrote(ctx, session, box):
    ip_id = _hero(ctx, session)
    _edit(ctx, session, ip_id, description=NAVY)
    ip = store.get_ip(ctx, session["sessionId"], ip_id)
    assert ip["version"] == 2
    prompt = _still_prompt(ctx, session, ip_id)
    assert "navy blue travel cloak" in prompt and "brown" not in prompt


def test_without_a_rewrite_the_clause_the_change_names_gives_way_to_the_change(ctx, session, box):
    ip_id = _hero(ctx, session)
    _edit(ctx, session, ip_id)
    prompt = _still_prompt(ctx, session, ip_id)
    assert "brown" not in prompt and "navy blue" in prompt
    assert "copper-colored full-face mask helmet" in prompt and "leather gloves" in prompt  # the rest is kept


def test_restoring_v1_brings_back_its_own_description(ctx, session, box):
    ip_id = _hero(ctx, session)
    _edit(ctx, session, ip_id, description=NAVY)
    snap = store.snapshot(ctx, session["sessionId"])
    v1 = next(a for a in snap["assets"] if a["kind"] == "image" and (a.get("meta") or {}).get("version") == 1)
    tools.run_tool(ctx, session, "restore_ip_version", {"ipId": ip_id, "imageAssetId": v1["assetId"]})
    prompt = _still_prompt(ctx, session, ip_id)
    assert "brown travel cloak" in prompt and "navy" not in prompt


def test_the_agent_state_shows_the_current_description(ctx, session, box):
    ip_id = _hero(ctx, session)
    _edit(ctx, session, ip_id, description=NAVY)
    state = agent.state_summary(store.snapshot(ctx, session["sessionId"]))
    assert "navy blue travel cloak" in state and "brown travel cloak" not in state


def test_merge_edit_keeps_the_subject_clause_and_drops_only_what_the_change_names():
    merged = tools.merge_edit(V1, "make the boots red")
    assert merged.startswith("young human male explorer") and "sturdy boots" not in merged
    assert "make the boots red" in merged and "brown travel cloak" in merged
    assert tools.merge_edit(V1, "add a red scarf").startswith(V1)  # nothing named: the change is added


def test_a_promoted_models_edit_states_one_eta_with_its_cold_box_boot(ctx, session, box, monkeypatch):
    from server import connections, waits
    from server.tests.test_round12_klein import CATALOG, QWEN, PromotedBox
    monkeypatch.setattr(connections, "image_catalog", lambda ctx: CATALOG)
    PromotedBox(box, monkeypatch)
    out = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "character", "name": "카이로", "description": V1})
    _run(ctx, session)
    out = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": out["ipId"], "prompt": "change the cloak to navy blue"})
    assert out["model"] == QWEN and out["etaMinutes"] == waits.PROMOTED_BOOT_MIN + 1
    said = out["message"]
    assert f"약 {waits.PROMOTED_BOOT_MIN + 1}분" in said and "Qwen-Image 2.1" in said
    assert "약 3분" not in said and "더 걸립니다" not in said and said.count("분 뒤") == 1


def test_the_rig_jobs_line_says_rigging_not_the_turntable():
    from server.providers.rig import RigProvider
    from server.tests.conftest import FakeDeadline, make_ctx
    deadline = FakeDeadline()
    deadline._job_responses["dl-1"] = {"taskRunStatus": "RUNNING", "lifecycleStatus": "CREATE_COMPLETE"}
    job = {"pk": "SESSION#ses_1", "jobId": "job_r1", "externalId": "dl-1", "input": {"glbKey": "k"}}
    state, line = RigProvider(template_loader=dict).status(job, make_ctx(deadline=deadline))
    assert state == "running" and "움직임 뼈대 넣는 중" in line and "3D 회전 영상" not in line
    deadline._job_responses["dl-1"]["taskRunStatus"] = "PENDING"
    waiting = RigProvider(template_loader=dict).status(job, make_ctx(deadline=deadline))[1]
    assert waiting.startswith("렌더 서버 순서 기다리는 중") and "3D 회전 영상" not in waiting  # the farm's line, not the turntable's


def test_the_video_boxs_english_phases_read_in_korean():
    from server.providers import mediagen_video as mv
    assert mv._progress({"phase": "queued"}) == "GPU 대기열에서 순서 기다리는 중"
    assert mv._progress({"phase": "denoising", "step": 3, "steps": 30}) == "영상 생성 중 10%"
    assert mv._progress({"phase": "some_new_phase"}) == mv.WORKING  # never the raw word
    assert mv._progress({}) == mv.WORKING


def test_a_job_records_when_its_work_began(ctx, session, box):
    out = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "character", "name": "카이로", "description": V1})
    job = store.get_job(ctx, session["sessionId"], out["jobId"])
    assert "startedAt" not in job and job["input"]["modelLabel"]  # the card names the model from the catalog
    _run(ctx, session, 1)
    job = store.get_job(ctx, session["sessionId"], out["jobId"])
    assert job["startedAt"] >= job["createdAt"]


def test_the_reply_names_the_button_not_the_tool():
    said = ("v2가 적용되면 render_3d를 다시 걸어 새 3D를 만들어야 합니다. `make_action_shot`으로 샷을 만들고 "
            "cut_trailer와 잇습니다.")
    # the buttons' words: one table with the work log (tools._LABELS)
    assert agent._strip_marker(said) == ("v2가 적용되면 3D로 만들기를 다시 걸어 새 3D를 만들어야 합니다. 액션 샷으로 샷을 "
                                         "만들고 트레일러 만들기와 잇습니다.")
    assert agent.humanize_tools("render_3d가 끝나면 publish_game은") == "3D로 만들기가 끝나면 게시하기는"
    assert {s["toolSpec"]["name"] if "toolSpec" in s else s["name"] for s in tools.TOOL_SPECS} <= set(agent.TOOL_LABELS)
