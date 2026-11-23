"""scripts/deploy.sh end to end on fakes, no AWS and no network: aws, npx, npm and boto3 only log what they were asked,
so the test sees which step talks to what, in which order."""
import importlib.util
import json
import os
import pathlib
import shutil
import struct
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
BUCKET = "ipverse-assets-087967639890-us-east-1"
OUTPUTS = {"IpverseCore": {"CdnDomainOutput": "d1.cloudfront.net", "UserPoolIdOutput": "pool",
                           "ClientIdOutput": "client", "AssetsBucketOutput": BUCKET}}
AWS = """#!/bin/sh
echo "aws $*" >> "$DEPLOY_LOG"
case "$*" in
  cloudformation\\ describe-stacks*) [ -n "$FAKE_STACK_BUCKET" ] || exit 254; echo "$FAKE_STACK_BUCKET" ;;
esac
"""
NPX = """#!/bin/sh
echo "npx $*" >> "$DEPLOY_LOG"
while [ $# -gt 0 ]; do [ "$1" = --outputs-file ] && printf '%s' "$FAKE_OUTPUTS" > "$2"; shift; done
"""
NPM = """#!/bin/sh
echo "npm $*" >> "$DEPLOY_LOG"
"""
STEP = """import os, sys
with open(os.environ["DEPLOY_LOG"], "a") as f:
    f.write("python3 " + os.path.relpath(sys.argv[0]) + "\\n")
"""
BOTO3 = '''import os


def _log(*parts):
    with open(os.environ["DEPLOY_LOG"], "a") as f:
        f.write(" ".join(map(str, parts)) + "\\n")


class _Client:
    def __init__(self, service):
        self.service = service

    def upload_file(self, filename, bucket, key, ExtraArgs=None):
        _log("boto3", self.service, "upload_file", bucket, key)

    def put_object(self, Bucket, Key, **kwargs):
        _log("boto3", self.service, "put_object", Bucket, Key)

    def get_paginator(self, name):
        return type("Pages", (), {"paginate": lambda self, **kwargs: []})()

    def get_function_configuration(self, **kwargs):
        return {"Environment": {"Variables": {}}}


def client(service, **kwargs):
    return _Client(service)
'''


def _deploy(tmp_path, stack_bucket):
    """Runs a copy of deploy.sh (and upload_web.py) against the real game/ and game3d/ runtime files.
    stack_bucket: what the existing IpverseCore stack reports as its assets bucket ("" = no stack yet)."""
    root, bin_dir, lib = tmp_path / "repo", tmp_path / "bin", tmp_path / "lib"
    for rel in ("scripts/deploy.sh", "scripts/upload_web.py"):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO / rel, root / rel)
    for rel in ("infra/build_layer.py", "scripts/package_server.py", "scripts/create_demo_user.py"):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(STEP)
    for rel in ("game", "game3d"):
        (root / rel).symlink_to(REPO / rel)
    (root / "workers/rig").mkdir(parents=True)
    (root / "workers/rig/ual.glb").write_bytes(b"glTF")
    shutil.copytree(REPO / "web/public", root / "web/dist")  # the build copies web/public into web/dist as it is
    (root / "web/dist/index.html").write_text("<!doctype html>")
    bin_dir.mkdir()
    for name, body in (("aws", AWS), ("npx", NPX), ("npm", NPM)):
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    lib.mkdir()
    (lib / "boto3.py").write_text(BOTO3)
    log = tmp_path / "deploy.log"
    env = {k: v for k, v in os.environ.items() if not k.startswith("AWS_")}
    env.update(PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", PYTHONPATH=str(lib), DEPLOY_LOG=str(log),
               FAKE_OUTPUTS=json.dumps(OUTPUTS), FAKE_STACK_BUCKET=stack_bucket,
               # anything that slipped past the fakes finds no credentials to act with
               AWS_CONFIG_FILE=os.devnull, AWS_SHARED_CREDENTIALS_FILE=os.devnull, AWS_ACCESS_KEY_ID="testing",
               AWS_SECRET_ACCESS_KEY="testing", AWS_EC2_METADATA_DISABLED="true")
    done = subprocess.run(["bash", str(root / "scripts/deploy.sh")], env=env, capture_output=True, text=True,
                          timeout=120)
    assert done.returncode == 0, done.stdout + done.stderr
    lines = log.read_text().splitlines()
    cdk = next(i for i, line in enumerate(lines) if line.startswith("npx aws-cdk@latest deploy"))
    uploads = [(i, line.split()[-1]) for i, line in enumerate(lines)
               if line.startswith(f"boto3 s3 upload_file {BUCKET} ")]
    return [key for i, key in uploads if i < cdk], [key for i, key in uploads if i > cdk]


def test_the_game_runtime_is_uploaded_before_the_cdk_deploy_swaps_the_server(tmp_path):
    """make_game freezes a copy of runtime3d/v1 into each game, so the runtime must be up before the new server
    emits what only the new authored-contract.js / city-contract.js accept."""
    before, after = _deploy(tmp_path, BUCKET)
    contracts = {"runtime3d/v1/authored-contract.js", "runtime3d/v1/city-contract.js", "runtime/v1/gamespec.js"}
    assert contracts <= set(before)
    assert not [key for key in before if key.startswith("web/")]  # the web app follows the server it calls
    assert "web/index.html" in after and "runtime3d/v1/authored-contract.js" in after  # upload_web.py


def test_a_first_deploy_uploads_the_runtime_once_the_stack_exists(tmp_path):
    before, after = _deploy(tmp_path, "")  # no stack yet: no bucket, and no old server to race
    assert before == [] and "runtime3d/v1/authored-contract.js" in after


def test_the_site_root_gets_a_real_favicon(tmp_path):
    """A game page names no icon, so the browser asks the site root (the bucket's web/): web/public/favicon.ico goes
    into web/dist with the build and up to web/favicon.ico with the web app."""
    icon = REPO / "web/public/favicon.ico"
    assert icon.is_file(), "no favicon in web/public"
    data = icon.read_bytes()
    reserved, kind, count = struct.unpack_from("<HHH", data)
    assert (reserved, kind) == (0, 1) and count >= 1, "not an ICO file"
    sizes = set()
    for n in range(count):  # ICONDIRENTRY: width, height (0 = 256), colours, reserved, planes, bpp, bytes, offset
        width, height, _, _, _, _, size, offset = struct.unpack_from("<BBBBHHII", data, 6 + 16 * n)
        assert size > 0 and offset + size <= len(data)
        sizes.add((width or 256, height or 256))
    assert {(16, 16), (32, 32)} <= sizes, sizes  # a tab's icon, plain and on a dense screen
    _, after = _deploy(tmp_path, BUCKET)
    assert "web/favicon.ico" in after
    spec = importlib.util.spec_from_file_location("upload_web", REPO / "scripts/upload_web.py")
    upload_web = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(upload_web)
    assert upload_web.content_type(icon) == "image/x-icon"
