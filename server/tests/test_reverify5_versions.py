"""The agent's state names the IP's current version and what each image job drew, on a fake image GPU box and a fake
clock (no network). A draw that never lands saves no version and uses no number, so the next one that passes takes it.
"""
import json

from server import agent, prompts, store, tools
from server.tests.test_cutout import W, png_rgba
from server.tests.test_image_jobs import ScriptedModel, _concept, _create, _poll, _snap, world  # noqa: F401

STAFF = "빛나는 마법 지팡이"
TWO_CUT = png_rgba([(20, 70, 100, 90, 255), (140, 70, W, 90, 255)])  # v2's draws: two subjects, the right one cut


def _staff_rerolls(w):
    """A staff at v1, then four rerolls from its card: v2 fails its check, the third is never drawn. → its ipId."""
    _concept(w)
    w["cutouts"].update({b"\x89PNG-g2": TWO_CUT, b"\x89PNG-g3": TWO_CUT})  # v2 is drawn twice, both fail
    ip_id = _create(w, STAFF, kind="weapon")["ipId"]
    _poll(w)
    for reroll in range(4):
        if reroll == 2:
            w["box"].fail_next.append("RuntimeError: CUDA out of memory")  # v4 is never drawn
        w["clock"].sleep(60)  # a minute or so between the clicks
        assert tools.run_tool(w["ctx"], w["session"], "reroll_ip_image", {"ipId": ip_id})["status"] == "queued"
        _poll(w)
    return ip_id


def _staff_jobs(state, ip_id):
    """The staff's image jobs in the state, by the version each drew."""
    return sorted((j for j in state["jobs"] if j["kind"] == "image" and j.get("ipId") == ip_id),
                  key=lambda j: j.get("version") or 0)


def test_n8_the_state_says_the_ips_current_version_and_what_each_image_job_drew(world):
    ip_id = _staff_rerolls(world)
    assert store.get_ip(world["ctx"], world["sid"], ip_id)["version"] == 4  # what the card says

    state = json.loads(agent.state_summary(_snap(world)))

    assert next(i for i in state["ips"] if i["ipId"] == ip_id)["version"] == 4
    drew = [(j.get("version"), j["status"], j.get("check")) for j in _staff_jobs(state, ip_id)]
    assert drew == [(1, "done", "ok"), (2, "done", "failed"), (3, "done", "ok"), (4, "failed", None),
                    (4, "done", "ok")]  # the lost draw's number goes to the next draw that lands
    v2, v4 = _staff_jobs(state, ip_id)[1], _staff_jobs(state, ip_id)[3]
    # its own cut; which picture is used is said for the IP's current version
    assert "피사체 2개" in v2["error"] and v2["error"].endswith("새 그림(v2)은 버전 기록에만 있고 지금 그림은 다른 버전(v4)이에요.")
    assert v4["error"]  # why it failed; it saved no picture, so v4 is not in the version history


def test_n8_the_agents_turn_reads_those_facts(world):
    ip_id = _staff_rerolls(world)
    ctx, sid = world["ctx"], world["sid"]
    store.put_message(ctx, sid, "user", "지팡이를 여러 번 다시 뽑았는데, 각 버전이 어떻게 됐고 지금 어떤 그림을 쓰는지 알려줘", "done")
    reply = store.put_message(ctx, sid, "assistant", "", "pending", ts=store.now(offset_ms=1))
    end = {"stopReason": "end_turn", "output": {"message": {"role": "assistant", "content": [{"text": "네"}]}}}
    ctx.bedrock_rt_east = model = ScriptedModel(lambda messages: end)

    agent.run_turn(ctx, sid, reply["messageId"])

    [call] = model.calls
    state = agent.state_summary(_snap(world))
    assert state in call["system"][0]["text"]
    assert next(i for i in json.loads(state)["ips"] if i["ipId"] == ip_id)["version"] == 4
    assert [j.get("version") for j in _staff_jobs(json.loads(state), ip_id)] == [1, 2, 3, 4, 4]


def test_n8_the_image_rule_names_the_current_version_and_how_to_say_it():
    [rule] = [line for line in prompts.SYSTEM.splitlines() if "state.ips[].version" in line]
    assert "현재 그림의 버전" in rule  # the IP's version is the picture it uses now
    assert "image 작업의 version" in rule and "check" in rule  # what each draw was and how its check went
    assert "지금 그림은 vN" in rule and "추측하지 않는다" in rule  # said plainly, never "probably the fourth"
    assert "버전 기록에 없다" in rule  # a failed draw saved no version
