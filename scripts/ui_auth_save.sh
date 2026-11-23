#!/usr/bin/env bash
# Save the demo credentials from Secrets Manager into agent-browser's encrypted auth vault.
# The password never reaches the terminal or the agent transcript.
# Usage: bash scripts/ui_auth_save.sh   (then: agent-browser auth login ipverse)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/build"
KEY_FILE="$ROOT/build/.agent-browser-key"
if [ ! -f "$KEY_FILE" ]; then
  openssl rand -hex 32 > "$KEY_FILE"
fi
export AGENT_BROWSER_ENCRYPTION_KEY="$(cat "$KEY_FILE")"
SECRET_JSON="$(aws secretsmanager get-secret-value --secret-id ipverse/demo-user --region us-east-1 --query SecretString --output text)"
USERNAME="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["username"])' "$SECRET_JSON")"
URL="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["cloudfrontUrl"])' "$SECRET_JSON")"
python3 -c 'import json,sys; print(json.loads(sys.argv[1])["password"])' "$SECRET_JSON" \
  | agent-browser auth save ipverse --url "$URL" --username "$USERNAME" --password-stdin
echo "saved auth profile 'ipverse' for $USERNAME at $URL"
echo "export AGENT_BROWSER_ENCRYPTION_KEY=\$(cat $KEY_FILE) before agent-browser auth login ipverse"
