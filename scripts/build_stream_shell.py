#!/usr/bin/env python3
"""Package the GameLift Streams web player (workers/stream-shell + official Electron win32-x64) and upload it.

  python3 scripts/build_stream_shell.py [--version v1]

Downloads Electron (checksum-verified against the release SHASUMS256.txt), unpacks it, renames electron.exe to
ipverse-player.exe, puts main.js/package.json in resources/app/, and syncs the folder to
s3://ipverse-ue5-builds-<account>-us-west-2/ipverse-web-player/<version>/app/ (the IpverseStreams builds bucket,
which GameLift Streams can read). Nothing downloaded is executed here.
"""
import hashlib
import pathlib
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
ELECTRON = "33.2.1"
NAME = f"electron-v{ELECTRON}-win32-x64.zip"
BASE = f"https://github.com/electron/electron/releases/download/v{ELECTRON}/"
OUT = ROOT / "build" / "stream-shell"
BUCKET = "ipverse-ue5-builds-087967639890-us-west-2"
version = sys.argv[sys.argv.index("--version") + 1] if "--version" in sys.argv else "v1"

OUT.mkdir(parents=True, exist_ok=True)
zpath = OUT / "electron.zip"
if not zpath.exists():
    urllib.request.urlretrieve(BASE + NAME, zpath)
sums = urllib.request.urlopen(BASE + "SHASUMS256.txt", timeout=60).read().decode()
want = next(line.split()[0] for line in sums.splitlines() if line.strip().endswith(NAME))
got = hashlib.sha256(zpath.read_bytes()).hexdigest()
if got != want:
    raise SystemExit(f"checksum mismatch for {NAME}: {got} != {want}")
app = OUT / "app"
if app.exists():
    shutil.rmtree(app)
with zipfile.ZipFile(zpath) as z:
    z.extractall(app)
(app / "electron.exe").rename(app / "ipverse-player.exe")
(app / "resources" / "default_app.asar").unlink(missing_ok=True)
dest = app / "resources" / "app"
dest.mkdir(parents=True, exist_ok=True)
for f in ("main.js", "package.json"):
    shutil.copy(ROOT / "workers" / "stream-shell" / f, dest / f)
print(f"packaged {sum(p.stat().st_size for p in app.rglob('*') if p.is_file()) / 1e6:.0f} MB in {app}")
subprocess.run(["aws", "s3", "sync", str(app), f"s3://{BUCKET}/ipverse-web-player/{version}/app/", "--delete",
                "--region", "us-west-2", "--only-show-errors"], check=True)
print(f"uploaded s3://{BUCKET}/ipverse-web-player/{version}/app/  executable: ipverse-player.exe")
