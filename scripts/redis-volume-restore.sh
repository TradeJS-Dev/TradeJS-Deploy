#!/usr/bin/env bash
set -euo pipefail

backup_path="${1:-}"
volume_source="${2:-}"
expected_persistent_keys="${3:-}"
archive_prefix="${4:-pre-restore}"
redis_image="redis/redis-stack:7.4.0-v8"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
restore_name="inv-redis-volume-restore-$timestamp-$$"
persistent_count_script="local cursor='0'; local count=0; repeat local result=redis.call('SCAN', cursor, 'COUNT', 1000); cursor=result[1]; for _, key in ipairs(result[2]) do if redis.call('PTTL', key) == -1 then count=count+1 end end until cursor == '0'; return count"

if [ ! -f "$backup_path" ] || [ ! -f "$backup_path.sha256" ]; then
  printf 'Redis backup or checksum is missing: %s\n' "$backup_path" >&2
  exit 1
fi
if [[ ! "$volume_source" =~ ^([A-Za-z0-9_.-]+|/[A-Za-z0-9_./-]+)$ ]]; then
  printf 'Invalid Redis volume source: %s\n' "$volume_source" >&2
  exit 1
fi
if [[ ! "$expected_persistent_keys" =~ ^[0-9]+$ ]]; then
  printf 'Invalid expected persistent-key count: %s\n' \
    "$expected_persistent_keys" >&2
  exit 1
fi
if [[ ! "$archive_prefix" =~ ^[a-z-]+$ ]]; then
  printf 'Invalid Redis archive prefix: %s\n' "$archive_prefix" >&2
  exit 1
fi

cleanup() {
  docker rm -f "$restore_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sha256sum --check "$backup_path.sha256"
docker run --rm --user 0 --entrypoint redis-check-rdb \
  -v "$backup_path:/restore/dump.rdb:ro" \
  "$redis_image" /restore/dump.rdb >/dev/null

archive_dir="/data/$archive_prefix-$timestamp"
docker run --rm --user 0 --entrypoint sh \
  -e RESTORE_ARCHIVE_DIR="$archive_dir" \
  -v "$volume_source:/data" \
  -v "$backup_path:/restore/dump.rdb:ro" \
  "$redis_image" -c '
    set -eu
    mkdir -p "$RESTORE_ARCHIVE_DIR"
    for path in /data/dump.rdb /data/appendonly.aof /data/appendonlydir; do
      if [ -e "$path" ]; then
        mv "$path" "$RESTORE_ARCHIVE_DIR/"
      fi
    done
    cp /restore/dump.rdb /data/dump.rdb
    chmod 644 /data/dump.rdb
  '

docker run -d --name "$restore_name" --user 0 \
  -v "$volume_source:/data" "$redis_image" \
  redis-stack-server --dir /data --dbfilename dump.rdb \
  --appendonly no >/dev/null

restore_ready=false
for _attempt in $(seq 1 300); do
  if docker exec "$restore_name" redis-cli ping 2>/dev/null | grep -q PONG; then
    restore_ready=true
    break
  fi
  sleep 1
done
if [ "$restore_ready" != true ]; then
  docker logs "$restore_name"
  echo 'Redis volume restore did not become ready' >&2
  exit 1
fi

restored_persistent_keys="$(
  docker exec "$restore_name" redis-cli --raw EVAL \
    "$persistent_count_script" 0
)"
if [ "$restored_persistent_keys" != "$expected_persistent_keys" ]; then
  printf 'Redis volume restore persistent-key mismatch: expected=%s restored=%s\n' \
    "$expected_persistent_keys" "$restored_persistent_keys" >&2
  exit 1
fi

docker exec "$restore_name" redis-cli CONFIG SET appendonly yes >/dev/null
aof_ready=false
for _attempt in $(seq 1 300); do
  persistence_info="$(
    docker exec "$restore_name" redis-cli --raw INFO persistence | tr -d '\r'
  )"
  aof_enabled="$(printf '%s\n' "$persistence_info" | sed -n 's/^aof_enabled://p')"
  aof_rewrite="$(printf '%s\n' "$persistence_info" | sed -n 's/^aof_rewrite_in_progress://p')"
  aof_status="$(printf '%s\n' "$persistence_info" | sed -n 's/^aof_last_bgrewrite_status://p')"
  if [ "$aof_enabled" = 1 ] && [ "$aof_rewrite" = 0 ] && \
    [ "$aof_status" = ok ]
  then
    aof_ready=true
    break
  fi
  sleep 1
done
if [ "$aof_ready" != true ]; then
  docker logs "$restore_name"
  echo 'Redis volume restore could not create a durable AOF' >&2
  exit 1
fi

aof_persistent_keys="$(
  docker exec "$restore_name" redis-cli --raw EVAL \
    "$persistent_count_script" 0
)"
if [ "$aof_persistent_keys" != "$expected_persistent_keys" ]; then
  printf 'Redis AOF conversion persistent-key mismatch: expected=%s actual=%s\n' \
    "$expected_persistent_keys" "$aof_persistent_keys" >&2
  exit 1
fi

docker exec "$restore_name" redis-cli SHUTDOWN NOSAVE >/dev/null 2>&1 || true
for _attempt in $(seq 1 30); do
  [ "$(docker inspect --format='{{.State.Running}}' "$restore_name")" = false ] && break
  sleep 1
done
printf 'Prepared Redis volume from %s with %s persistent keys and durable AOF\n' \
  "$backup_path" "$aof_persistent_keys"
