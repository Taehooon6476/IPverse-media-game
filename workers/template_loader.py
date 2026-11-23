"""Deadline Cloud job template for the relief worker, with blender_relief.py embedded at load time."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_template() -> dict:
    """deadline_relief_template.json with the "@@RELIEF@@" placeholder replaced by blender_relief.py."""
    template = json.loads((HERE / "deadline_relief_template.json").read_text(encoding="utf-8"))
    for f in template["steps"][0]["script"]["embeddedFiles"]:
        if f["name"] == "Relief":
            f["data"] = (HERE / "blender_relief.py").read_text(encoding="utf-8")
    return template


def load_rig_template() -> dict:
    """rig/deadline_rig_template.json with every "@@file@@" embedded file replaced by workers/rig/<file>."""
    rig = HERE / "rig"
    template = json.loads((rig / "deadline_rig_template.json").read_text(encoding="utf-8"))
    for f in template["steps"][0]["script"]["embeddedFiles"]:
        f["data"] = (rig / f["data"].strip("@")).read_text(encoding="utf-8")
        if "{{" in f["data"] or "}}" in f["data"]:  # OpenJD parses those as expressions and rejects the job
            raise ValueError("workers/rig/%s contains a double brace" % f["name"])
    return template
