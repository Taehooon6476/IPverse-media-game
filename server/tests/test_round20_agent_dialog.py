"""The agent dialog's one-click schedule examples (web/src/components/AgentDialog.tsx SCHEDULE_EXAMPLES) are all
expressions the server takes and can say in words."""
import pathlib
import re

from server import agents

DIALOG = pathlib.Path(__file__).resolve().parents[2] / "web" / "src" / "components" / "AgentDialog.tsx"


def _examples() -> list:
    listed = DIALOG.read_text(encoding="utf-8").split("SCHEDULE_EXAMPLES", 1)[1].split("];", 1)[0]
    return re.findall(r"\['([^']+)', '([^']+)'\]", listed)


def test_every_schedule_example_of_the_agent_dialog_is_taken_by_the_server():
    examples = _examples()
    assert len(examples) >= 4, examples
    for label, expr in examples:
        assert agents.validate_cron(expr) == expr, (label, expr)


def test_the_agent_list_can_say_each_example_in_words():
    """Words, not the raw expression (the exact words are the server's to choose)."""
    for label, expr in _examples():
        said = agents.schedule_label(expr)
        assert said != expr and "(" not in said, (label, expr, said)
