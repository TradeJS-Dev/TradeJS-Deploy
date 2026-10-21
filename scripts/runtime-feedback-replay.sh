#!/usr/bin/env bash

set -Eeuo pipefail

readonly deployment_id="${RUNTIME_FEEDBACK_DEPLOYMENT_ID:-production}"
readonly evidence_root="${RUNTIME_EVIDENCE_READY_DIR:-$HOME/data/runtime-evidence/ready/$deployment_id}"
readonly feedback_root="${RUNTIME_FEEDBACK_ROOT:-$HOME/data/runtime-feedback}"
readonly app_feedback_root="${RUNTIME_FEEDBACK_APP_ROOT:-/app/data/runtime-feedback}"
readonly feedback_env_file="${RUNTIME_FEEDBACK_ENV_FILE:-$HOME/.runtime-feedback.env}"
readonly network="${RUNTIME_FEEDBACK_NETWORK:-tradejs-runtime-replay}"
readonly image_repository="ghcr.io/tradejs-dev/tradejs-project-app"
readonly redis_image="redis/redis-stack:7.4.0-v8"
readonly lock_file="${RUNTIME_FEEDBACK_LOCK_FILE:-$HOME/.runtime-feedback.lock}"
readonly max_bundles="${RUNTIME_FEEDBACK_MAX_BUNDLES_PER_RUN:-3}"
readonly minimum_available_kb="${RUNTIME_FEEDBACK_MIN_AVAILABLE_KB:-7340032}"
readonly replay_memory="${RUNTIME_FEEDBACK_REPLAY_MEMORY:-7g}"
readonly replay_node_heap_mb="${RUNTIME_FEEDBACK_NODE_HEAP_MB:-6144}"
readonly lease_days="${RUNTIME_FEEDBACK_IMAGE_RETENTION_DAYS:-30}"

requested_artifact=""
rerun=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact)
      requested_artifact="${2:-}"
      shift 2
      ;;
    --rerun)
      rerun=true
      shift
      ;;
    *)
      echo "Unsupported runtime-feedback-replay argument: $1" >&2
      exit 1
      ;;
  esac
done
if [ -n "$requested_artifact" ] && [[ ! "$requested_artifact" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "Invalid artifact id: $requested_artifact" >&2
  exit 1
fi
if [[ ! "$max_bundles" =~ ^[1-9][0-9]*$ ]] || \
  [[ ! "$minimum_available_kb" =~ ^[1-9][0-9]*$ ]] || \
  [[ ! "$replay_memory" =~ ^[1-9][0-9]*[mMgG]$ ]] || \
  [[ ! "$replay_node_heap_mb" =~ ^[1-9][0-9]*$ ]] || \
  [[ ! "$lease_days" =~ ^[1-9][0-9]*$ ]]; then
  echo "Runtime feedback limits are invalid" >&2
  exit 1
fi
if [ ! -f "$feedback_env_file" ]; then
  echo "Runtime feedback environment is missing: $feedback_env_file" >&2
  exit 1
fi

mkdir -p "$feedback_root/incoming" "$feedback_root/ready/$deployment_id" \
  "$feedback_root/failed" "$feedback_root/completed/$deployment_id" \
  "$feedback_root/notify-pending/$deployment_id" \
  "$feedback_root/notified/$deployment_id" "$feedback_root/work"
exec 9>"$lock_file"
flock -n 9 || {
  echo "Another runtime feedback replay is already running."
  exit 0
}

app_health="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' app 2>/dev/null || true)"
if [ "$app_health" != healthy ]; then
  echo "Production app is not healthy: ${app_health:-missing}" >&2
  exit 1
fi
available_kb="$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)"
if [ -z "$available_kb" ] || [ "$available_kb" -lt "$minimum_available_kb" ]; then
  echo "Insufficient host memory for replay: available_kb=${available_kb:-unknown}" >&2
  exit 1
fi
docker network inspect "$network" >/dev/null

attempted=0
processed=0
failed=0
notification_failed=0

notify_ready_bundle() {
  [ "${RUNTIME_FEEDBACK_NOTIFY:-true}" != false ] || return 0
  local artifact_id="$1"
  local ready_bundle="$2"
  local notification_file="$feedback_root/notified/$deployment_id/$artifact_id.json"
  local pending_file="$feedback_root/notify-pending/$deployment_id/$artifact_id"
  local container_bundle
  local notification_tmp
  local notification_status

  if [ -f "$notification_file" ]; then
    rm -f "$pending_file"
    return 0
  fi
  case "$ready_bundle" in
    "$feedback_root"/*)
      container_bundle="$app_feedback_root/${ready_bundle#"$feedback_root"/}"
      ;;
    *)
      echo "Runtime feedback bundle is outside the shared data root: $ready_bundle" >&2
      return 1
      ;;
  esac

  set +e
  docker exec app /app/node_modules/.bin/tradejs runtime-feedback-notify --bundle "$container_bundle"
  notification_status=$?
  set -e
  if [ "$notification_status" -ne 0 ]; then
    echo "Runtime feedback notification failed: $artifact_id (status=$notification_status)" >&2
    return 1
  fi

  notification_tmp="${notification_file}.tmp-$$"
  printf '{"schemaVersion":1,"runtimeEvidenceArtifactId":"%s","runtimeFeedbackBundle":"%s","notifiedAt":%s}\n' \
    "$artifact_id" "$ready_bundle" "$(date +%s000)" > "$notification_tmp"
  mv "$notification_tmp" "$notification_file"
  rm -f "$pending_file"
  echo "Runtime feedback notification sent: $ready_bundle"
}

queue_complete_files() {
  local complete_file
  local artifact_id
  local priority

  while IFS= read -r complete_file; do
    artifact_id="$(basename "$(dirname "$complete_file")")"
    priority=0
    if [ -n "$(find "$feedback_root/failed" -maxdepth 1 -type d -name "${artifact_id}-*" -print -quit)" ]; then
      priority=1
    fi
    printf '%s\t%s\n' "$priority" "$complete_file"
  done < <(find "$evidence_root" -type f -name .complete -print 2>/dev/null | sort) | \
    sort -t $'\t' -k1,1n -k2,2 | cut -f2-
}

while IFS= read -r complete_file; do
  bundle_dir="$(dirname "$complete_file")"
  artifact_hint="$(basename "$bundle_dir")"
  if [ -n "$requested_artifact" ] && [ "$artifact_hint" != "$requested_artifact" ]; then
    continue
  fi
  completion_file="$feedback_root/completed/$deployment_id/$artifact_hint.json"
  if [ "$rerun" != true ] && [ -f "$completion_file" ]; then
    pending_file="$feedback_root/notify-pending/$deployment_id/$artifact_hint"
    if [ -f "$pending_file" ]; then
      IFS= read -r ready_dir < "$pending_file"
      if ! notify_ready_bundle "$artifact_hint" "$ready_dir"; then
        notification_failed=$((notification_failed + 1))
      fi
    fi
    continue
  fi

  runtime_evidence="$bundle_dir/runtime-evidence.json"
  if [ ! -f "$runtime_evidence" ] || [ ! -f "$bundle_dir/manifest.json" ]; then
    echo "Skipping incomplete evidence bundle: $bundle_dir" >&2
    continue
  fi
  parser_image_id="$(docker inspect --format '{{.Image}}' app)"
  metadata="$(docker run --rm --pull=never --network none --read-only \
    --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$bundle_dir:/runtime-evidence:ro" \
    --entrypoint node "$parser_image_id" --input-type=module --eval '
    import fs from "node:fs";
    const file = process.argv[1];
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const producer = value.producer ?? {};
    const window = value.window ?? {};
    const deployment = value.deployment ?? {};
    if (producer.imageDigest == null && producer.projectSha == null) {
      process.stdout.write("legacy");
      process.exit(0);
    }
    const parts = [
      producer.imageDigest,
      producer.projectSha,
      deployment.id,
      window.endTime,
    ];
    if (!/^sha256:[0-9a-f]{64}$/.test(String(parts[0])) ||
        !/^[0-9a-f]{40}$/.test(String(parts[1])) ||
        !/^[a-zA-Z0-9._-]+$/.test(String(parts[2])) ||
        !Number.isFinite(Number(parts[3]))) {
      throw new Error("Invalid runtime evidence producer metadata");
    }
    process.stdout.write(parts.join("\t"));
  ' /runtime-evidence/runtime-evidence.json)"
  if [ "$metadata" = legacy ]; then
    echo "Skipping legacy evidence without image identity: $artifact_hint"
    continue
  fi
  IFS=$'\t' read -r image_digest project_sha evidence_deployment end_time <<< "$metadata"
  if [ "$evidence_deployment" != "$deployment_id" ]; then
    echo "Evidence deployment mismatch: $evidence_deployment" >&2
    exit 1
  fi

  image_ref="$image_repository@$image_digest"
  image_id="$(docker image inspect --format '{{.Id}}' "$image_ref" 2>/dev/null || true)"
  if [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "Exact deployed image is no longer local: $image_ref" >&2
    exit 1
  fi

  run_id="$(date -u +%Y%m%dT%H%M%SZ)-${project_sha:0:12}"
  incoming_dir="$feedback_root/incoming/$artifact_hint/$run_id"
  work_dir="$feedback_root/work/$artifact_hint-$run_id"
  redis_name="runtime-feedback-redis-${artifact_hint:0:24}-${run_id:0:15}"
  replay_name="runtime-feedback-replay-${artifact_hint:0:24}-${run_id:0:15}"
  lease_name="runtime-feedback-image-${artifact_hint:0:40}"
  mkdir -p "$incoming_dir" "$work_dir"
  chown 1000:1000 "$incoming_dir" "$work_dir"

  cleanup_bundle() {
    docker rm -f "$redis_name" >/dev/null 2>&1 || true
    docker rm -f "$replay_name" >/dev/null 2>&1 || true
  }
  trap cleanup_bundle EXIT
  trap 'exit 143' TERM INT
  docker run -d --pull=never --name "$redis_name" \
    --network "$network" --network-alias "$redis_name" \
    --memory 512m --cpus 0.5 --pids-limit 128 \
    --tmpfs /data:rw,noexec,nosuid,size=384m \
    --cap-drop ALL --security-opt no-new-privileges:true \
    "$redis_image" redis-stack-server --dir /data --save '' --appendonly no >/dev/null
  redis_ready=false
  for _attempt in $(seq 1 60); do
    if docker exec "$redis_name" redis-cli ping 2>/dev/null | grep -q PONG; then
      redis_ready=true
      break
    fi
    sleep 1
  done
  [ "$redis_ready" = true ] || {
    echo "Isolated replay Redis did not become ready" >&2
    exit 1
  }

  set +e
  attempted=$((attempted + 1))
  timeout --signal=TERM --kill-after=30s 2h docker run --rm --pull=never \
    --name "$replay_name" --user 1000:1000 --network "$network" \
    --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m \
    --memory "$replay_memory" --memory-swap "$replay_memory" \
    --cpus 1.5 --pids-limit 256 \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --env-file "$feedback_env_file" \
    -e PROJECT_CWD=/app -e DOTENV_CONFIG_PATH=/nonexistent \
    -e REDIS_HOST="$redis_name" -e REDIS_PORT=6379 \
    -e PG_HOST=timescale -e PG_PORT=5432 \
    -e ML_GRPC_ADDRESS=ml-infer:50051 \
    -e 'PGOPTIONS=-c default_transaction_read_only=on' \
    -e TRADEJS_TIMESCALE_READ_ONLY=true \
    -e RUNTIME_FEEDBACK_ISOLATED_REDIS=true \
    -e MAKE_ORDERS=false -e TRADEJS_EXTERNAL_ORDER_PLACEMENT=false \
    -e TRADEJS_PROJECT_IMAGE_DIGEST="$image_digest" \
    -e NODE_OPTIONS="--max-old-space-size=$replay_node_heap_mb" \
    -v "$bundle_dir:/runtime-evidence:ro" \
    -v "$incoming_dir:/runtime-feedback-output:rw" \
    -v "$work_dir:/app/data:rw" \
    --entrypoint /app/node_modules/.bin/tradejs "$image_id" \
    runtime-feedback-replay \
    --runtimeEvidence /runtime-evidence/runtime-evidence.json \
    --outDir /runtime-feedback-output --runId "$run_id"
  replay_status=$?
  set -e
  cleanup_bundle
  trap - EXIT TERM INT

  if [ "$replay_status" -ne 0 ] || [ ! -f "$incoming_dir/.complete" ]; then
    failed_dir="$feedback_root/failed/$artifact_hint-$run_id"
    mv "$incoming_dir" "$failed_dir"
    rm -rf "$work_dir"
    echo "Runtime feedback replay failed: $artifact_hint (status=$replay_status)" >&2
    failed=$((failed + 1))
    [ "$attempted" -lt "$max_bundles" ] || break
    continue
  fi

  date_path="$(date -u -d "@$((end_time / 1000))" +%Y/%m/%d)"
  ready_dir="$feedback_root/ready/$deployment_id/$date_path/$artifact_hint/$run_id"
  mkdir -p "$(dirname "$ready_dir")"
  mv "$incoming_dir" "$ready_dir"
  rm -rf "$work_dir"
  docker rm "$lease_name" >/dev/null 2>&1 || true
  expires_at="$(( $(date +%s) + lease_days * 86400 ))"
  docker create --name "$lease_name" --pull=never \
    --label tradejs.runtime-feedback.image-lease=true \
    --label tradejs.runtime-feedback.expires-at="$expires_at" \
    --entrypoint /bin/true "$image_id" >/dev/null

  receipt_tmp="${completion_file}.tmp-$$"
  printf '{"schemaVersion":1,"runtimeEvidenceArtifactId":"%s","runtimeFeedbackBundle":"%s","completedAt":%s}\n' \
    "$artifact_hint" "$ready_dir" "$(date +%s000)" > "$receipt_tmp"
  mv "$receipt_tmp" "$completion_file"

  if [ "${RUNTIME_FEEDBACK_NOTIFY:-true}" != false ]; then
    pending_file="$feedback_root/notify-pending/$deployment_id/$artifact_hint"
    pending_tmp="${pending_file}.tmp-$$"
    printf '%s\n' "$ready_dir" > "$pending_tmp"
    mv "$pending_tmp" "$pending_file"
  fi

  echo "Runtime feedback replay ready: $ready_dir"
  processed=$((processed + 1))
  if ! notify_ready_bundle "$artifact_hint" "$ready_dir"; then
    notification_failed=$((notification_failed + 1))
  fi
  [ "$attempted" -lt "$max_bundles" ] || break
done < <(queue_complete_files)

if [ "$attempted" -eq 0 ]; then
  echo "No pending runtime evidence bundles."
fi
if [ "$failed" -gt 0 ] || [ "$notification_failed" -gt 0 ]; then
  echo "Runtime feedback replay completed with failures: attempted=$attempted failed=$failed ready=$processed notificationFailed=$notification_failed" >&2
  exit 1
fi
