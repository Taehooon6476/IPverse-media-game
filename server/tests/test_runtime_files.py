"""Every local module the 3D runtime imports is published with each game: a file missing from RUNTIME3D_FILES makes
the game fail to load."""
import pathlib
import re

from server import tools

GAME3D = pathlib.Path(__file__).resolve().parents[2] / "game3d"


def test_every_local_import_of_a_published_runtime_file_is_published_too():
    published = set(tools.RUNTIME3D_FILES) | set(tools.CITY_RUNTIME_FILES) | set(tools.TRACK_RUNTIME_FILES)
    missing = set()
    for name in published:
        if not name.endswith(".js"):
            continue
        for dep in re.findall(r"""(?:from|import)\s*\(?\s*['"]\./([\w.-]+\.js)['"]""", (GAME3D / name).read_text()):
            if dep not in published:
                missing.add(f"{name} -> {dep}")
    assert not missing, missing
