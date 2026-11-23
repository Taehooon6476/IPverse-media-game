from pathlib import Path

from workers.template_loader import load_template


def test_template_embeds_current_relief_script():
    t = load_template()
    relief = next(f for f in t["steps"][0]["script"]["embeddedFiles"] if f["name"] == "Relief")
    assert relief["data"] == Path("workers/blender_relief.py").read_text()
    names = {p["name"] for p in t["parameterDefinitions"]}
    assert names >= {"InputUri", "OutputPrefix", "Frames", "Width", "Height", "Samples", "Accent", "CondaPackages", "CondaChannels"}
    assert t["specificationVersion"] == "jobtemplate-2023-09"


def test_run_script_is_valid_python():
    run = next(f for f in load_template()["steps"][0]["script"]["embeddedFiles"] if f["name"] == "Run")
    compile(run["data"], "Run", "exec")
