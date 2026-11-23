#!/usr/bin/env bash
# Press a sequence of keys in an agent-browser session with a short pause between them (game play checks).
# Usage: bash scripts/keys.sh <session> <key> [key...]   e.g. bash scripts/keys.sh rpg ArrowDown ArrowDown e
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export AGENT_BROWSER_ENCRYPTION_KEY="$(cat "$ROOT/build/.agent-browser-key")"
session="$1"; shift
for key in "$@"; do
  agent-browser --session "$session" press "$key" >/dev/null
  agent-browser --session "$session" wait 250 >/dev/null
done
