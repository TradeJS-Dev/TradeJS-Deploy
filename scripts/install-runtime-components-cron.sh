#!/usr/bin/env bash
set -Eeuo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${DEPLOY_ROOT:-$HOME}"
source_sha="${1:-}"
[[ "$source_sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Exact Deploy source SHA is required' >&2; exit 1; }
private="$(python3 "${script_dir}/collector-state.py" "$source_sha")"
existing="$(crontab -l 2>/dev/null || true)"
{
  printf '%s\n' "$existing" | sed '/^# tradejs-runtime-components:start$/,/^# tradejs-runtime-components:end$/d'
  printf '# tradejs-runtime-components:start\nCRON_TZ=Europe/Moscow\n'
  printf '30 10 * * * DEPLOY_ROOT=%q python3 %q >> %q 2>&1\n' "$PWD" "$PWD/scripts/capture-runtime-components.py" "$private/components.log"
  printf '# tradejs-runtime-components:end\n'
} | crontab -
