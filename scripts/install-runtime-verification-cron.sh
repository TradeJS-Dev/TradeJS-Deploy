#!/usr/bin/env bash
set -Eeuo pipefail
cd "${DEPLOY_ROOT:-$HOME}"
mkdir -p data/runtime-verification
existing="$(crontab -l 2>/dev/null || true)"
{
  printf '%s\n' "$existing" | sed '/# tradejs-runtime-verification$/d'
  printf '*/5 * * * * %q observe >> %q 2>&1 # tradejs-runtime-verification\n' "$PWD/scripts/capture-runtime-verification.sh" "$PWD/data/runtime-verification/collector.log"
} | crontab -
