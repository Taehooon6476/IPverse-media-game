#!/usr/bin/env bash
# Deploy the image-to-3D GPU worker (IpverseImg3d stack: SQS + g6e.2xlarge running Hunyuan3D-2.1).
#   bash scripts/deploy_img3d.sh            upload worker files to S3, cdk deploy IpverseImg3d
#   bash scripts/deploy_img3d.sh --restart  also restart the worker service via SSM (picks up a new worker.py)
#   bash scripts/deploy_img3d.sh --setup    also re-run setup.sh via SSM (after a failed first-boot install)
# First boot: user data downloads img3d/worker/setup.sh and installs everything (~25 min, /var/log/img3d-setup.log).
# The box has no inbound rules; use `aws ssm start-session --target <id>` to look inside.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION=us-east-1
BUCKET="ipverse-assets-087967639890-$REGION"

for f in worker.py meshclean.py setup.sh ipverse-img3d.service; do  # worker.py fetches meshclean.py on start
  aws s3 cp "$ROOT/workers/img3d/$f" "s3://$BUCKET/img3d/worker/$f" --region "$REGION"
done

(cd "$ROOT/infra" && JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1 npx aws-cdk@latest deploy IpverseImg3d \
  --require-approval never --outputs-file "$ROOT/build/img3d-outputs.json")

ssm_run() {
  local id
  id=$(aws ec2 describe-instances --region "$REGION" --filters Name=tag:ipverse,Values=img3d \
       Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId' --output text)
  [ -n "$id" ] || { echo "img3d instance is not running; start it first"; exit 1; }
  aws ssm send-command --region "$REGION" --instance-ids "$id" --document-name AWS-RunShellScript \
    --parameters "commands=[\"$1\"]" --query Command.CommandId --output text
}
case "${1:-}" in
  --restart) ssm_run "systemctl restart ipverse-img3d.service" ;;  # kills a job in flight; use when idle
  --setup) ssm_run "aws s3 cp s3://$BUCKET/img3d/worker/setup.sh /opt/img3d/setup.sh && nohup bash /opt/img3d/setup.sh >/dev/null 2>&1 &" ;;
esac
