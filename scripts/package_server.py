#!/usr/bin/env python3
"""
Copy server/ + workers/ into build/server/server/ for Lambda packaging.
Bundle layout: build/server/server/app.py, .../providers/, .../workers/
Handler: server.app.handler
Run: python3 scripts/package_server.py
"""
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC_SERVER = ROOT / "server"
SRC_WORKERS = ROOT / "workers"
# Lambda zip root; server package lives one level deeper so `import server.app` works
DEST_ROOT = ROOT / "build" / "server"
DEST = DEST_ROOT / "server"


def package_server() -> None:
    if not SRC_SERVER.exists():
        print(f"ERROR: {SRC_SERVER} does not exist. Run other task agents first.", file=sys.stderr)
        sys.exit(1)

    if DEST_ROOT.exists():
        shutil.rmtree(DEST_ROOT)
    DEST.mkdir(parents=True)

    for item in SRC_SERVER.iterdir():
        if item.name in ("tests", "__pycache__") or item.suffix == ".pyc":
            continue
        dst = DEST / item.name
        if item.is_dir():
            shutil.copytree(item, dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "tests"))
        else:
            shutil.copy2(item, dst)

    if SRC_WORKERS.exists():
        worker_dest = DEST / "workers"
        worker_dest.mkdir(exist_ok=True)
        for fname in ("blender_relief.py", "template_loader.py", "deadline_relief_template.json"):
            src = SRC_WORKERS / fname
            if src.exists():
                shutil.copy2(src, worker_dest / fname)
            else:
                print(f"  WARNING: {fname} not found in workers/", file=sys.stderr)
    else:
        print("  WARNING: workers/ not found — skipping worker copy.", file=sys.stderr)

    # The bundle must import from its own root, as Lambda does.
    env = {**os.environ, "PYTHONPATH": str(DEST_ROOT)}
    result = subprocess.run(
        [sys.executable, "-c", "import server.app"],
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"ERROR: import check failed — server.app not importable from bundle:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)
    print(f"  Import check OK: server.app importable from {DEST_ROOT}")

    print(f"Packaged server to {DEST_ROOT} (handler: server.app.handler)")


if __name__ == "__main__":
    package_server()
