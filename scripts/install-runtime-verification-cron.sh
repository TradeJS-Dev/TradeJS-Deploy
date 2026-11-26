#!/usr/bin/env bash
set -Eeuo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${DEPLOY_ROOT:-$HOME}"
private="$(python3 "${script_dir}/collector-state.py")"
existing="$(crontab -l 2>/dev/null || true)"
{
  printf '%s\n' "$existing" | sed '/# tradejs-runtime-verification$/d'
  printf '*/5 * * * * %q observe >> %q 2>&1 # tradejs-runtime-verification\n' "$PWD/scripts/capture-runtime-verification.sh" "$private/verification.log"
} | crontab -
