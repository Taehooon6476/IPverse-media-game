#!/usr/bin/env bash
# Visible (headed) agent-browser session "live" for walking the user through the app.
# Usage: bash scripts/live.sh <agent-browser args...>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export AGENT_BROWSER_ENCRYPTION_KEY="$(cat "$ROOT/build/.agent-browser-key")"
exec agent-browser --headed --session live "$@"
