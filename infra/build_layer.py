#!/usr/bin/env python3
"""
Assemble the Lambda layer for ffmpeg:
  - ffmpeg  : BtbN GPL build (has drawtext / freetype+fribidi+harfbuzz)
  - (no ffprobe: the server parses durations from `ffmpeg -i`)
  - font    : NotoSansKR-Bold.otf

Both tarballs are cached under build/cache/.
Fails the build if the assembled layer exceeds 230 MB (AWS hard limit 250 MB).
Run: python3 infra/build_layer.py
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "build" / "cache"
LAYER_DIR = ROOT / "build" / "ffmpeg-layer"
BIN_DIR = LAYER_DIR / "bin"
FONTS_DIR = LAYER_DIR / "fonts"

# BtbN GPL — has drawtext (freetype + fribidi + harfbuzz)
BTBN_URL = (
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
    "ffmpeg-master-latest-linux64-gpl.tar.xz"
)
BTBN_CACHE = CACHE_DIR / "ffmpeg-master-latest-linux64-gpl.tar.xz"

# johnvansickle static — compact (~80 MB), used only for ffprobe
JVS_URL = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
JVS_CACHE = CACHE_DIR / "ffmpeg-release-amd64-static.tar.xz"

FONT_URLS = [
    "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/KR/NotoSansKR-Bold.otf",
    "https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/KR/NotoSansKR-Bold.otf",
]
FONT_DEST = FONTS_DIR / "NotoSansKR-Bold.otf"

SIZE_LIMIT_BYTES = 230 * 1024 * 1024  # 230 MB — fail before hitting the 250 MB AWS hard limit


def download(url: str, dest: pathlib.Path) -> None:
    print(f"  Downloading {url} …", flush=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    try:
        urllib.request.urlretrieve(url, tmp)
        tmp.rename(dest)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def extract_binary(cache: pathlib.Path, binary: str, dest: pathlib.Path) -> None:
    """Extract a single binary from a tarball into dest/."""
    extract_dir = CACHE_DIR / f"extract-{cache.stem}"
    if not extract_dir.exists():
        print(f"  Extracting {cache.name} …", flush=True)
        extract_dir.mkdir(parents=True)
        with tarfile.open(cache, "r:xz") as tf:
            tf.extractall(extract_dir)

    found = False
    for candidate in extract_dir.rglob(binary):
        if candidate.is_file() and candidate.stat().st_size > 1_000_000:
            shutil.copy2(candidate, dest / binary)
            (dest / binary).chmod(0o755)
            size_mb = candidate.stat().st_size / 1024 / 1024
            print(f"  Copied {binary} from {cache.name} ({size_mb:.1f} MB)")
            found = True
            break
    if not found:
        print(f"ERROR: {binary} not found in {cache.name}", file=sys.stderr)
        sys.exit(1)


def dir_size(path: pathlib.Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def build_ffmpeg_layer() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    FONTS_DIR.mkdir(parents=True, exist_ok=True)

    # ── Remove stale binaries ─────────────────────────────────────────────────
    for stale in BIN_DIR.iterdir():
        stale.unlink()
        print(f"  Removed stale binary: {stale.name}")

    # ── ffmpeg from BtbN GPL (has drawtext) ───────────────────────────────────
    if not BTBN_CACHE.exists():
        download(BTBN_URL, BTBN_CACHE)
    else:
        print(f"  Using cached {BTBN_CACHE.name}")
    extract_binary(BTBN_CACHE, "ffmpeg", BIN_DIR)

    # ffprobe intentionally omitted: server uses `ffmpeg -i` for probing.
    # Shipping only ffmpeg keeps the unzipped layer well under 250 MB.

    # ── NotoSansKR font ───────────────────────────────────────────────────────
    if not FONT_DEST.exists():
        for url in FONT_URLS:
            try:
                download(url, FONT_DEST)
                break
            except Exception as e:
                print(f"  Font download failed ({url}): {e}", file=sys.stderr)
        else:
            print("WARNING: Could not download NotoSansKR-Bold.otf", file=sys.stderr)
    else:
        print("  Font already present, skipping download.")

    # ── UPX-compress both binaries (BtbN is pre-stripped; UPX reduces ~60%) ───
    if shutil.which("docker"):
        size_before = (BIN_DIR / "ffmpeg").stat().st_size / 1024 / 1024
        print(f"  UPX-compressing ffmpeg ({size_before:.1f} MB) …", flush=True)
        upx_cmd = [
            "docker", "run", "--rm",
            "--platform", "linux/amd64",
            "-v", f"{BIN_DIR}:/work",
            "alpine:3",
            "sh", "-c",
            "apk add --no-cache upx -q && upx -5 /work/ffmpeg",
        ]
        r = subprocess.run(upx_cmd, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"  WARNING: upx failed:\n{r.stdout}\n{r.stderr} — continuing uncompressed", file=sys.stderr)
        else:
            size_after = (BIN_DIR / "ffmpeg").stat().st_size / 1024 / 1024
            print(f"  UPX done: ffmpeg {size_before:.1f}→{size_after:.1f} MB")
    else:
        print("  Docker not available — cannot UPX-compress; layer may exceed 250 MB limit.")

    # ── Size check ────────────────────────────────────────────────────────────
    total_bytes = dir_size(LAYER_DIR)
    total_mb = total_bytes / 1024 / 1024
    print(f"\nLayer total size: {total_mb:.1f} MB ({total_bytes:,} bytes)")
    if total_bytes > SIZE_LIMIT_BYTES:
        print(
            f"ERROR: Layer size {total_mb:.1f} MB exceeds the {SIZE_LIMIT_BYTES // 1024 // 1024} MB limit. "
            "Reduce binaries before deploying.",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"  Size check OK (limit {SIZE_LIMIT_BYTES // 1024 // 1024} MB)")

    # ── Docker verify: drawtext must be present ───────────────────────────────
    if shutil.which("docker"):
        print("  Verifying drawtext filter with Docker …", flush=True)
        cmd = [
            "docker", "run", "--rm",
            "--platform", "linux/amd64",
            "--entrypoint", "/opt/bin/ffmpeg",
            "-v", f"{LAYER_DIR}:/opt",
            "public.ecr.aws/lambda/python:3.12",
            "-hide_banner", "-filters",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(
                f"ERROR: ffmpeg failed to run in Lambda container:\n{result.stderr}",
                file=sys.stderr,
            )
            sys.exit(1)
        if "drawtext" not in (result.stdout + result.stderr):
            print("ERROR: drawtext filter not found in ffmpeg output.", file=sys.stderr)
            sys.exit(1)
        print("  ffmpeg drawtext: OK")
    else:
        print("  Docker not available — skipping drawtext verification.")

    print(f"\nLayer built at: {LAYER_DIR}")


if __name__ == "__main__":
    build_ffmpeg_layer()
