#!/usr/bin/env bash

set -Eeuo pipefail

readonly deployment_id="${RUNTIME_FEEDBACK_DEPLOYMENT_ID:-production}"
readonly feedback_root="${RUNTIME_FEEDBACK_ROOT:-$HOME/data/runtime-feedback}"
readonly log_path="${RUNTIME_FEEDBACK_LOG_PATH:-${DEPLOY_ROOT:-$HOME}/.tradejs-collector-state/feedback-cron.log}"
readonly failed_retention_days="${RUNTIME_FEEDBACK_FAILED_RETENTION_DAYS:-30}"
readonly log_retention_days="${RUNTIME_FEEDBACK_LOG_RETENTION_DAYS:-30}"
readonly log_max_bytes="${RUNTIME_FEEDBACK_LOG_MAX_BYTES:-10485760}"
readonly failed_root="$feedback_root/failed"
readonly completed_root="$feedback_root/completed/$deployment_id"

if [[ ! "$failed_retention_days" =~ ^[1-9][0-9]*$ ]] || \
  [[ ! "$log_retention_days" =~ ^[1-9][0-9]*$ ]] || \
  [[ ! "$log_max_bytes" =~ ^[1-9][0-9]*$ ]]; then
  echo "Runtime feedback maintenance limits are invalid" >&2
  exit 1
fi

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$script_dir/feedback-files.py" maintenance "$feedback_root" "$deployment_id" "$log_path" "$failed_retention_days" "$log_retention_days" "$log_max_bytes"
