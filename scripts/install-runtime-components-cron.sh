#!/usr/bin/env bash
set -Eeuo pipefail
cd "${DEPLOY_ROOT:-$HOME}"
source_sha="${1:-}"
[[ "$source_sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Exact Deploy source SHA is required' >&2; exit 1; }
mkdir -p data/runtime-components
printf '%s\n' "$source_sha" > data/runtime-components/deploy-source-sha.incoming
mv data/runtime-components/deploy-source-sha.incoming data/runtime-components/deploy-source-sha
existing="$(crontab -l 2>/dev/null || true)"
{
  printf '%s\n' "$existing" | sed '/^# tradejs-runtime-components:start$/,/^# tradejs-runtime-components:end$/d'
  printf '# tradejs-runtime-components:start\nCRON_TZ=Europe/Moscow\n'
  printf '30 10 * * * DEPLOY_ROOT=%q python3 %q >> %q 2>&1\n' "$PWD" "$PWD/scripts/capture-runtime-components.py" "$PWD/data/runtime-components/collector.log"
  printf '# tradejs-runtime-components:end\n'
} | crontab -
