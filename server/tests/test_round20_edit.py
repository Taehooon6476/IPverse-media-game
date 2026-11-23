"""An edit keeps the reference's own background, whatever it is (a first picture may have scenery although its prompt
asks for a plain studio): the keep clause, the redraw and the edit check's question all name the reference's own
background, never a plain one."""
import pytest

from server import tools
from server.providers import bedrock_image, mediagen_image as mi
from server.tests.test_mediagen_image import _ip, _run, box, ctx, session  # noqa: F401 (fixtures)

RED_CLOAK = "wearing a red cloak instead of the green one"  # a change as the agent sends it
STYLE = "stylized fantasy illustration, soft painterly lighting, storybook feel"


@pytest.mark.parametrize("look,covered", [("figure", False), ("figure", True), ("creature", False), ("object", False)])
def test_the_keep_clause_names_the_references_own_background_and_never_a_plain_one(look, covered):
    prompt = tools.edit_prompt("리라", RED_CLOAK, look, STYLE, covered)
    assert prompt.startswith(RED_CLOAK + ". Change only that, clearly visible.")  # the change still leads
    keep = prompt.split("Change only that", 1)[1]
    assert "the reference image's own background unchanged" in keep
    assert "plain" not in keep and "studio" not in keep
    assert keep.endswith(f"art style ({STYLE}). No text.")


def test_the_live_edit_is_sent_with_the_forest_kept(ctx, session, box):  # noqa: F811
    base = _ip(ctx, session, {"name": "리라", "description": "young girl archer guardian of the starlit forest, "
                                                           "flowing emerald green cloak with leaf-shaped clasp"})
    _run(ctx, session)
    tools.run_tool(ctx, session, "make_ip_variant", {"ipId": base["ipId"], "prompt": RED_CLOAK})
    _run(ctx, session)
    sent = box.starts[-1]["prompt"]
    assert sent.startswith(RED_CLOAK + ". Change only that")
    assert "the same pose and framing, the reference image's own background unchanged and the same art style" in sent
    assert "plain background" not in sent


@pytest.mark.parametrize("change", [
    "the background is a snowy pine forest at night",
    "a huge pale full moon centered directly behind the beetle, larger than the beetle's body",
    "standing in a rainy neon alley", "replace the backdrop with a sunset sky",
    "under a starry night sky", "a blood-red moon rising behind her", "silhouetted against the sunset",
    "the sky behind her turns stormy", "standing on a cliff at sunrise", "in a snowy forest", "in the ruins of a castle"])
def test_an_edit_that_names_the_background_is_not_told_to_keep_it(change):
    prompt = tools.edit_prompt("가시 딱정벌레", change, "creature", STYLE)
    keep = prompt.split("Change only that", 1)[1]
    assert "background" not in keep and "the same pose and framing" in keep
    assert keep.endswith(f"art style ({STYLE}). No text.")


@pytest.mark.parametrize("change", [
    # the sky's words as a colour of the subject
    "wearing a sky-blue cape", "sunset orange hair",
    "sky blue scarf around the neck", "a moon-white cloak with silver trim", "armor in horizon blue",
    "a sunrise-yellow sash", "a night-sky blue robe", "wearing a cloak in a forest green", "a cape the colour of the sunset",
    # ... and as an ornament it wears
    "a crescent moon pendant on the chest", "a moon emblem on the shield", "a starry sky pattern on the cloak",
    "a moon-shaped clasp"])
def test_a_colour_or_an_ornament_named_after_the_sky_is_no_backdrop(change):
    """"sky-blue cape" is no edit of the backdrop: its draw still carries the keep-background clause."""
    keep = tools.edit_prompt("리라", change).split("Change only that", 1)[1]
    assert "the reference image's own background unchanged" in keep, change


@pytest.mark.parametrize("change", [RED_CLOAK, "a red scarf around the neck", "the staff glows blue",
                                    "holding the sword behind the shield"])
def test_an_edit_of_the_subject_alone_keeps_it(change):
    assert "the reference image's own background unchanged" in tools.edit_prompt("리라", change)


def test_the_redraw_of_a_rejected_edit_holds_to_the_references_background_too():
    edit = tools.edit_prompt("리라", RED_CLOAK, "figure", STYLE)
    job = {"jobId": "job_1", "pk": "SESSION#s", "redraws": 1, "redrawFor": ["edit"],
           "input": {"model": "klein9", "prompt": edit, "references": ["sessions/s/v1.png"], "subject": "figure",
                     "edit": RED_CLOAK}}
    extra = mi._redraw_prompt(job)[len(edit):]
    assert mi.KEEP_HARDER in extra
    assert "the reference image's own background exactly as it is" in mi.KEEP_HARDER
    assert "nothing added to it and nothing taken out of it" in mi.KEEP_HARDER
    # the redraw that pulls the camera back (a cut figure) names that background as well
    reframed = mi._redraw_prompt({**job, "redrawFor": ["composition"]})[len(edit):]
    assert mi.REFRAME_EDIT["figure"] in reframed and mi.SAME_BACKGROUND in mi.REFRAME_EDIT["figure"]
    for line in (mi.KEEP_HARDER, *mi.REFRAME_EDIT.values()):
        assert "plain" not in line and "studio" not in line and "no scenery" not in line, line
    # an edit that asked for the backdrop: its redraw still leaves the backdrop to the edit
    asked = mi._redraw_prompt({**job, "redrawFor": ["composition", "backgroundAsked"]})[len(edit):]
    assert mi.KEEP_STYLE in asked and "background" not in asked


def test_the_check_judges_the_background_against_the_reference_as_it_is():
    question = bedrock_image.EDIT_QUESTION
    said = question.split('"background_changed"', 1)[1].split('"style_asked"', 1)[0]
    assert "a plain studio became a landscape" in said
    assert "scenery became a plain backdrop" in said  # ... and the other way round
    assert "Image 1's background is the one that must stay, whether it is a plain backdrop or full scenery" in question
    question.format(change=RED_CLOAK)  # still one placeholder, the braces of its JSON escaped
