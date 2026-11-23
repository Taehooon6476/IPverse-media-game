#!/usr/bin/env bash
# One-command deploy for IPverse Studio.
# Usage: bash scripts/deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Building ffmpeg layer..."
python3 infra/build_layer.py

echo "==> Packaging server..."
python3 scripts/package_server.py

# The game runtime goes up before the CDK deploy: make_game copies runtime3d/v1 into each game, so the runtime must
# already accept what the new server emits. A first deploy has no stack yet: upload_web.py uploads the runtime.
BUCKET=$(aws cloudformation describe-stacks --stack-name IpverseCore --region us-east-1 \
    --query "Stacks[0].Outputs[?OutputKey=='AssetsBucketOutput'].OutputValue" --output text 2>/dev/null || true)
if [ -n "$BUCKET" ] && [ "$BUCKET" != "None" ]; then
    echo "==> Uploading game runtime to $BUCKET before the server..."
    python3 - "$BUCKET" <<'PY'
import sys
sys.path.insert(0, "scripts")
import boto3
from upload_web import GAME3D_DIR, GAME_DIR, RUNTIME3D_FILES, RUNTIME_FILES, content_type
s3 = boto3.client("s3", region_name="us-east-1")
for src, files, prefix in ((GAME_DIR, RUNTIME_FILES, "runtime/v1/"), (GAME3D_DIR, RUNTIME3D_FILES, "runtime3d/v1/")):
    for name in files:
        s3.upload_file(str(src / name), sys.argv[1], prefix + name, ExtraArgs={"ContentType": content_type(src / name)})
PY
fi
echo "==> Deploying CDK stacks..."
mkdir -p build
# aws-cdk@latest keeps the CLI's schema compatible with the installed aws-cdk-lib.
cd infra
JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1 npx aws-cdk@latest deploy --all \
    --require-approval never \
    --outputs-file "$ROOT/build/outputs.json"
cd "$ROOT"

# CDN_DOMAIN is set after the deploy: in the stack it would be a circular dependency with CloudFront.
CDN_DOMAIN=$(python3 -c "
import json, pathlib
outputs = json.loads(pathlib.Path('build/outputs.json').read_text())
core = outputs.get('IpverseCore', {})
print(core.get('CdnDomain') or core.get('CdnDomainOutput', ''))
")
if [ -n "$CDN_DOMAIN" ]; then
    echo "==> Patching CDN_DOMAIN=$CDN_DOMAIN into Lambda..."
    aws lambda update-function-configuration \
        --function-name ipverse-api \
        --region us-east-1 \
        --environment "$(python3 -c "
import json, boto3
fn = boto3.client('lambda', region_name='us-east-1').get_function_configuration(FunctionName='ipverse-api')
env = fn.get('Environment', {}).get('Variables', {})
env['CDN_DOMAIN'] = '$CDN_DOMAIN'
print(json.dumps({'Variables': env}))
        ")" \
        --output text --query 'FunctionName' > /dev/null
fi

echo "==> Building web frontend..."
VITE_API_BASE=/api npm --prefix web run build

echo "==> Uploading web and runtime assets..."
python3 scripts/upload_web.py

echo "==> Creating demo user..."
python3 scripts/create_demo_user.py

echo ""
echo "✅ Deploy complete."
