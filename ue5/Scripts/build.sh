#!/bin/bash
# Packages the UE5 template game on the IpverseUe5Build box (run as root through SSM by scripts/ue5_build.sh).
#   build.sh <version> [Shipping|Development]
# Inputs : s3://$UE5_BUILDS_BUCKET/ipverse-ue5/src/<version>.tar.gz (the ue5/ folder)
# Outputs: s3://$UE5_BUILDS_BUCKET/ipverse-ue5/<version>/app/                (GameLift Streams application root)
#          s3://$UE5_BUILDS_BUCKET/ipverse-ue5/<version>/IpverseGame-Linux.tar.gz
#          s3://$UE5_BUILDS_BUCKET/ipverse-ue5/<version>/build.log
set -euo pipefail
VERSION=${1:?version}
CONFIG=${2:-Shipping}
# shellcheck disable=SC1091
source /etc/ipverse-ue5.env # UE5_BUILDS_BUCKET, UE5_SECRET_ID
GLTF_SHA=cef7be26f803b1728508218957ea9d1baf01400d # glTFRuntime tag 20260826 (MIT)
FONT_URL=https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothic/NanumGothic-Bold.ttf # OFL
S3=s3://$UE5_BUILDS_BUCKET/ipverse-ue5
WORK=/opt/ue5/work
mkdir -p "$WORK"
LOG=$WORK/$VERSION.log
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1
touch /run/ipverse-build.lock
finish() {
  code=$?
  echo "== exit $code at $(date -u +%FT%TZ)"
  aws s3 cp "$LOG" "$S3/$VERSION/build.log" --region us-west-2 --only-show-errors || true
  rm -f /run/ipverse-build.lock
}
trap finish EXIT
step() { echo "== $(date -u +%T) $*"; }

step "project $VERSION ($CONFIG)"
rm -rf "$WORK/project" "$WORK/out"
mkdir -p "$WORK/project" "$WORK/out" "$WORK/ddc"
aws s3 cp "$S3/src/$VERSION.tar.gz" - --region us-west-2 | tar xz -C "$WORK/project"
git clone --quiet https://github.com/rdeioris/glTFRuntime.git "$WORK/project/Plugins/glTFRuntime"
git -C "$WORK/project/Plugins/glTFRuntime" checkout --quiet "$GLTF_SHA"
mkdir -p "$WORK/project/Content/Fonts"
curl -sSfL "$FONT_URL" -o "$WORK/project/Content/Fonts/NanumGothicBold.ttf"
[ "$(stat -c %s "$WORK/project/Content/Fonts/NanumGothicBold.ttf")" -gt 500000 ]

step "registry login"
SECRET=$(aws secretsmanager get-secret-value --secret-id "$UE5_SECRET_ID" --region us-east-1 --query SecretString --output text)
GH_USER=$(jq -r .username <<<"$SECRET")
GH_TOKEN=$(jq -r .token <<<"$SECRET")
echo "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin >/dev/null
if [ -z "${UE_IMAGE:-}" ]; then
  REG=$(curl -sSf -u "$GH_USER:$GH_TOKEN" "https://ghcr.io/token?scope=repository:epicgames/unreal-engine:pull" | jq -r .token)
  TAGS=$(curl -sSf -H "Authorization: Bearer $REG" "https://ghcr.io/v2/epicgames/unreal-engine/tags/list?n=10000" | jq -r '.tags[]')
  TAG=$(grep -E '^dev-slim-5\.6(\.[0-9]+)?$' <<<"$TAGS" | sort -V | tail -1)
  [ -n "$TAG" ] || { echo "no dev-slim-5.6 tag; available dev-slim tags:"; grep dev-slim <<<"$TAGS" | tail -20; exit 3; }
  UE_IMAGE=ghcr.io/epicgames/unreal-engine:$TAG
fi
unset SECRET GH_TOKEN REG
step "pull $UE_IMAGE"
docker pull --quiet "$UE_IMAGE"
docker image inspect "$UE_IMAGE" --format 'image size {{.Size}} bytes'

chown -R 1000:1000 "$WORK/project" "$WORK/out" "$WORK/ddc"
step "build editor module, content, package"
docker run --rm -u 1000:1000 \
  -v "$WORK/project:/project" -v "$WORK/out:/out" -v "$WORK/ddc:/ddc" \
  -e UE-LocalDataCachePath=/ddc -e CONFIG="$CONFIG" \
  "$UE_IMAGE" bash -c '
set -euo pipefail
UE=$(ls -d /home/ue4/UnrealEngine 2>/dev/null || ls -d /home/*/UnrealEngine | head -1)
echo "engine at $UE"; tr -d " \n" < "$UE/Engine/Build/Build.version"; echo
"$UE/Engine/Build/BatchFiles/Linux/Build.sh" IpverseGameEditor Linux Development -project=/project/IpverseGame.uproject -waitmutex
"$UE/Engine/Binaries/Linux/UnrealEditor-Cmd" /project/IpverseGame.uproject -run=pythonscript -script=/project/Scripts/build_levels.py \
  -unattended -nullrhi -nosplash -nop4 -nopause -stdout -FullStdOutLogOutput 2>&1 | tee /out/content.log | grep -E "IPVERSE|Error|error:" || true
grep -q IPVERSE_LEVELS_OK /out/content.log || { echo "content step failed"; tail -80 /out/content.log; exit 4; }
"$UE/Engine/Build/BatchFiles/RunUAT.sh" BuildCookRun -project=/project/IpverseGame.uproject -noP4 \
  -platform=Linux -clientconfig="$CONFIG" -build -cook -stage -pak -iostore -archive -archivedirectory=/out/archive \
  -utf8output -unattended -nocompileeditor
'

APP="$WORK/out/archive/Linux"
[ -x "$APP/IpverseGame.sh" ] || { echo "no IpverseGame.sh in $APP"; ls -la "$WORK/out/archive" "$APP" || true; exit 5; }
step "upload"
du -sh "$APP"
find "$APP" -type f | wc -l | xargs echo files:
aws s3 sync "$APP" "$S3/$VERSION/app/" --delete --region us-west-2 --only-show-errors
tar -C "$APP" -cf - . | pigz -p 16 > "$WORK/IpverseGame-Linux.tar.gz"
ls -la "$WORK/IpverseGame-Linux.tar.gz"
aws s3 cp "$WORK/IpverseGame-Linux.tar.gz" "$S3/$VERSION/IpverseGame-Linux.tar.gz" --region us-west-2 --only-show-errors
echo "IPVERSE_BUILD_OK $VERSION $UE_IMAGE"
