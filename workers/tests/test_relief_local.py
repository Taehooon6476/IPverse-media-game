"""Real Blender run of workers/blender_relief.py (skipped when Blender is not installed)."""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from workers.make_fixture import write_cutout_png, write_png

SCRIPT = Path(__file__).resolve().parents[1] / "blender_relief.py"
CANDIDATES = (os.environ.get("BLENDER"), "/Applications/Blender.app/Contents/MacOS/Blender")
BLENDER = next((p for p in (shutil.which(c) for c in CANDIDATES if c) if p), None)

pytestmark = pytest.mark.skipif(BLENDER is None, reason="Blender not found ($BLENDER or /Applications/Blender.app)")


def run_blender(args, check=True):
    proc = subprocess.run(
        [BLENDER, "-b", "--factory-startup", "-noaudio", "--python-exit-code", "1", "--python", str(SCRIPT), "--", *args],
        capture_output=True, text=True, errors="replace", timeout=600,
    )
    if check:
        assert proc.returncode == 0, proc.stdout[-4000:] + proc.stderr[-4000:]
    return proc


def test_relief_produces_frames_glb_poster(tmp_path):
    png = tmp_path / "cutout.png"; write_cutout_png(str(png))
    out = tmp_path / "out"
    run_blender(["--image", str(png), "--out", str(out), "--frames", "3", "--width", "320", "--height", "180", "--samples", "4", "--thickness", "0.12", "--accent", "#5de6cf"])
    assert sorted(p.name for p in (out / "frames").iterdir()) == ["0001.png", "0002.png", "0003.png"]
    assert (out / "model.glb").stat().st_size > 1000
    assert (out / "poster.png").exists()
    meta = json.loads((out / "meta.json").read_text())
    assert meta["frames"] == 3 and meta["faces"] > 50


def test_relief_rejects_fully_transparent_image(tmp_path):
    png = tmp_path / "empty.png"; write_png(str(png), 8, 8, [bytes(32)] * 8)
    proc = run_blender(["--image", str(png), "--out", str(tmp_path / "out")], check=False)
    assert proc.returncode != 0
    assert "no pixels with alpha >= 0.5" in proc.stdout + proc.stderr


def test_glb_mode_turns_an_imported_mesh_without_reexporting(tmp_path):
    png = tmp_path / "cutout.png"; write_cutout_png(str(png))
    relief = tmp_path / "relief"
    run_blender(["--image", str(png), "--out", str(relief), "--frames", "1", "--width", "160", "--height", "90", "--samples", "2"])
    out = tmp_path / "out"
    run_blender(["--glb", str(relief / "model.glb"), "--out", str(out), "--frames", "2", "--width", "160", "--height", "90", "--samples", "2"])
    assert sorted(p.name for p in (out / "frames").iterdir()) == ["0001.png", "0002.png"]
    assert (out / "poster.png").exists() and not (out / "model.glb").exists()
    meta = json.loads((out / "meta.json").read_text())
    assert meta["mode"] == "glb" and meta["faces"] > 50
