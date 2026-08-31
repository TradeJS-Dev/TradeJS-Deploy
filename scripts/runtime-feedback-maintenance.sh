#!/usr/bin/env bash

set -Eeuo pipefail

readonly deployment_id="${RUNTIME_FEEDBACK_DEPLOYMENT_ID:-production}"
readonly feedback_root="${RUNTIME_FEEDBACK_ROOT:-$HOME/data/runtime-feedback}"
readonly log_path="${RUNTIME_FEEDBACK_LOG_PATH:-$feedback_root/cron.log}"
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

mkdir -p "$failed_root" "$completed_root" "$(dirname "$log_path")"

while IFS= read -r failed_dir; do
  entry="$(basename "$failed_dir")"
  if [[ ! "$entry" =~ ^(.+)-[0-9]{8}T[0-9]{6}Z-[a-zA-Z0-9]+$ ]]; then
    continue
  fi
  artifact_id="${BASH_REMATCH[1]}"
  if [ ! -f "$completed_root/$artifact_id.json" ]; then
    continue
  fi
  if find "$failed_dir" -maxdepth 0 -mtime "+$failed_retention_days" -print -quit | grep -q .; then
    rm -rf -- "$failed_dir"
  fi
done < <(find "$failed_root" -mindepth 1 -maxdepth 1 -type d -print | sort)

if [ -f "$log_path" ]; then
  log_size="$(wc -c < "$log_path")"
  if [ "$log_size" -ge "$log_max_bytes" ]; then
    rotated_log="$log_path.$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$log_path" "$rotated_log"
    : > "$log_path"
  fi
fi

find "$(dirname "$log_path")" -maxdepth 1 -type f \
  -name "$(basename "$log_path").*" \
  -mtime "+$log_retention_days" -delete
