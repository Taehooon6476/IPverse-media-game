#!/usr/bin/env bash
# agent-browser wrapper: loads the vault encryption key and pins the session name.
# Usage: bash scripts/ab.sh <agent-browser args...>   e.g. bash scripts/ab.sh auth login ipverse
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export AGENT_BROWSER_ENCRYPTION_KEY="$(cat "$ROOT/build/.agent-browser-key")"
exec agent-browser --session ipverse "$@"
