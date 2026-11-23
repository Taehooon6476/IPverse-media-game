"""A klein edit keeps everything it was not asked to change: the keep clause names the helmet, armor, colors, lighting
and art style, and a composition redraw of an edit keeps the figure of the reference instead of drawing it anew.
"""
from server import prompts, tools
from server.providers import mediagen_image as mi
from server.tests.test_mediagen_image import _ip, _run, box, ctx, session  # noqa: F401 (fixtures)

M1_CHANGE = ("wearing a thick winter cloak with a fur-trimmed collar over the armor, frost and snow dusting the "
             "shoulders")
M17_CHANGE = "change the cape color from purple to crimson red"


def _variant_prompt(ctx, session, box, change, **ip):
    base = _ip(ctx, session, ip)
    _run(ctx, session)
    tools.run_tool(ctx, session, "make_ip_variant", {"ipId": base["ipId"], "prompt": change})
    _run(ctx, session)
    return box.starts[-1]["prompt"]


def test_m1_a_variant_keeps_the_head_helmet_armor_colors_and_named_art_style(ctx, session, box):
    prompt = _variant_prompt(ctx, session, box, M1_CHANGE, name="주인공 기사",
                             description="dark steel plate armor, closed great helm with a glowing red visor slit")
    assert prompt.startswith(M1_CHANGE + ". Change only that")  # the change leads (a long keep clause first: unchanged)
    keep = prompt.split("Change only that", 1)[1]
    # naming a face for a closed helm draws one; the helmet itself is kept (test_klein_edit_check.py)
    for kept in ("same helmet or head covering", "still closed", "armor", "colors", "lighting",
                 "pose", "framing", "background"):
        assert kept in keep, kept
    assert "face" not in prompt.lower()
    assert "art style (Pixar-like 3D)" in keep  # the concept's style by name: the GPU box's "real" preset pulls photoreal
    assert "Make this change clearly visible. Otherwise" not in prompt


def test_m17_a_color_edit_keeps_every_other_color_and_the_lighting(ctx, session, box):
    prompt = _variant_prompt(ctx, session, box, M17_CHANGE + ".", name="아스트로",
                             description="a silver robot knight wearing a flowing purple cape")
    assert prompt.startswith(M17_CHANGE + ". Change only that, clearly visible.")  # one period, not two
    assert "same armor, outfit, colors and lighting" in prompt


def test_an_object_or_creature_edit_keeps_its_colors_and_still_no_person():
    sword, beast = tools.edit_prompt("마법검", "red runes", "object"), tools.edit_prompt("용", "a scar", "creature")
    assert "colors" in sword and "no person" in sword and "no hands" in sword and "face" not in sword
    assert "colors and lighting" in beast and "face" not in beast
    assert tools.edit_prompt("마법검", "red runes", "object", "dark fantasy.").endswith(
        "art style (dark fantasy). No text.")  # the style names the art style, whatever the look


def test_m1_the_redraw_of_an_edit_pulls_the_camera_back_without_redrawing_the_character(ctx, box):
    p = mi.MediagenImageProvider()
    edit = tools.edit_prompt("주인공 기사", M1_CHANGE)
    job = {"jobId": "job_1", "pk": "SESSION#ses_1", "redraws": 1,
           "input": {"model": "klein9", "prompt": edit, "references": ["sessions/ses_1/v1.png"], "subject": "figure"}}
    p.submit(job, ctx)
    sent = box.starts[-1]["prompt"]
    assert sent.startswith(edit.rstrip(" .") + ". ") and "Redraw" not in sent
    assert "the same figure as in the reference image" in sent and "about half the frame height" in sent
    # a new picture without a reference still gets the plain redraw
    fresh = {**job, "input": {**job["input"], "references": []}}
    p.submit(fresh, ctx)
    assert box.starts[-1]["prompt"].endswith(mi.REFRAME["figure"])


def test_the_agent_writes_only_the_asked_change_and_adds_no_weather_or_keep_clause():
    s = prompts.SYSTEM
    assert "사용자가 말한 변경만" in s and "눈·날씨" in s  # the agent adds nothing to the user's change
    assert "keep everything else" in s  # the server writes the keep clause; the agent does not repeat it
    assert "투구" in s and "색·조명" in s
