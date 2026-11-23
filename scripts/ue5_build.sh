#!/bin/bash
# Package the UE5 template game on the IpverseUe5Build box (docs/ue5/design.md).
#   bash scripts/ue5_build.sh [version] [Shipping|Development]   start a build, print the SSM command id
#   bash scripts/ue5_build.sh --wait <command-id>                  wait, then print the build log tail
# Needs Secrets Manager ipverse/ghcr-token (GitHub PAT of an Epic-linked account, read:packages).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUCKET=ipverse-ue5-builds-087967639890-us-west-2
STACK=IpverseUe5Build
EAST="--region us-east-1"

instance_id() {
  aws cloudformation describe-stacks --stack-name "$STACK" $EAST \
    --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text
}

if [ "${1:-}" = "--wait" ]; then
  CMD=${2:?command id}
  ID=$(instance_id)
  while :; do
    STATUS=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$ID" $EAST --query Status --output text)
    case "$STATUS" in Pending|InProgress|Delayed) sleep 60 ;; *) break ;; esac
  done
  echo "status: $STATUS"
  VERSION=$(aws ssm list-commands --command-id "$CMD" $EAST --query 'Commands[0].Comment' --output text)
  aws s3 cp "s3://$BUCKET/ipverse-ue5/$VERSION/build.log" - --region us-west-2 | tail -60
  [ "$STATUS" = Success ]
  exit
fi

VERSION=${1:-$(date -u +%Y%m%d-%H%M)}
CONFIG=${2:-Shipping}
aws secretsmanager describe-secret --secret-id ipverse/ghcr-token $EAST >/dev/null \
  || { echo "secret ipverse/ghcr-token is missing (GitHub PAT of the Epic-linked account)"; exit 2; }

echo "uploading ue5/ as $VERSION"
COPYFILE_DISABLE=1 tar -C "$ROOT/ue5" --exclude Saved --exclude Intermediate --exclude Binaries --exclude DerivedDataCache \
  --exclude Plugins --exclude Packaged -czf - . | aws s3 cp - "s3://$BUCKET/ipverse-ue5/src/$VERSION.tar.gz" --region us-west-2
aws s3 cp "$ROOT/ue5/Scripts/build.sh" "s3://$BUCKET/ipverse-ue5/src/build.sh" --region us-west-2 --only-show-errors

ID=$(instance_id)
STATE=$(aws ec2 describe-instances --instance-ids "$ID" $EAST --query 'Reservations[0].Instances[0].State.Name' --output text)
if [ "$STATE" != running ]; then
  echo "starting $ID ($STATE)"
  [ "$STATE" = stopping ] && aws ec2 wait instance-stopped --instance-ids "$ID" $EAST
  aws ec2 start-instances --instance-ids "$ID" $EAST >/dev/null
  aws ec2 wait instance-running --instance-ids "$ID" $EAST
fi
until [ "$(aws ssm describe-instance-information $EAST --filters Key=InstanceIds,Values="$ID" \
  --query 'InstanceInformationList[0].PingStatus' --output text)" = Online ]; do sleep 10; done

RUN="aws s3 cp s3://$BUCKET/ipverse-ue5/src/build.sh /opt/ue5/build.sh --region us-west-2 && bash /opt/ue5/build.sh $VERSION $CONFIG"
aws ssm send-command --instance-ids "$ID" $EAST --document-name AWS-RunShellScript --comment "$VERSION" \
  --timeout-seconds 600 --parameters "commands=[\"$RUN\"],executionTimeout=[\"21600\"]" \
  --query Command.CommandId --output text
