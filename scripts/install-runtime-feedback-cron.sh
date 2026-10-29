#!/usr/bin/env bash

set -Eeuo pipefail

readonly script_path="${RUNTIME_FEEDBACK_SCRIPT_PATH:-$HOME/scripts/runtime-feedback-replay.sh}"
readonly maintenance_script_path="${RUNTIME_FEEDBACK_MAINTENANCE_SCRIPT_PATH:-$HOME/scripts/runtime-feedback-maintenance.sh}"
readonly log_path="${RUNTIME_FEEDBACK_LOG_PATH:-$HOME/data/runtime-feedback/cron.log}"
readonly marker_start='# tradejs-runtime-feedback:start'
readonly marker_end='# tradejs-runtime-feedback:end'

if [ ! -x "$script_path" ]; then
  echo "Runtime feedback script is not executable: $script_path" >&2
  exit 1
fi
if [ ! -x "$maintenance_script_path" ]; then
  echo "Runtime feedback maintenance script is not executable: $maintenance_script_path" >&2
  exit 1
fi
mkdir -p "$(dirname "$log_path")"
existing="$(crontab -l 2>/dev/null || true)"
filtered="$(printf '%s\n' "$existing" | awk -v start="$marker_start" -v end="$marker_end" '
  $0 == start { skip = 1; next }
  $0 == end { skip = 0; next }
  !skip { print }
')"
{
  printf '%s\n' "$filtered"
  printf '%s\n' "$marker_start"
  printf 'CRON_TZ=Europe/Moscow\n'
  printf '* * * * * python3 %q >> %q 2>&1\n' "$HOME/scripts/mcp-replay-host.py" "$HOME/data/runtime-feedback/mcp-host.log"
  printf '10 21 * * * %q\n' "$maintenance_script_path"
  printf '20 21 * * * python3 %q --enqueue-daily >> %q 2>&1\n' "$HOME/scripts/mcp-replay-host.py" "$log_path"
  printf '%s\n' "$marker_end"
} | crontab -

echo "Installed daily runtime feedback maintenance at 21:10 and replay at 21:20 Europe/Moscow."
