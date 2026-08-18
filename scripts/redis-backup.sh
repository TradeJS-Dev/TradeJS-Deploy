#!/usr/bin/env bash
set -euo pipefail

backup_root="${REDIS_BACKUP_DIR:-$HOME/backups/redis}"
retention_days="${REDIS_BACKUP_RETENTION_DAYS:-14}"
redis_image="redis/redis-stack:7.4.0-v8"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="$backup_root/dump-$timestamp.rdb"

mkdir -p "$backup_root"
source_dbsize="$(docker exec inv-redis redis-cli --raw DBSIZE)"
last_save_before="$(docker exec inv-redis redis-cli --raw LASTSAVE)"
while [ "$(date +%s)" -le "$last_save_before" ]; do
  sleep 1
done
docker exec inv-redis redis-cli BGSAVE >/dev/null
snapshot_ready=false
for _attempt in $(seq 1 120); do
  in_progress="$(docker exec inv-redis redis-cli --raw INFO persistence | tr -d '\r' | sed -n 's/^rdb_bgsave_in_progress://p')"
  last_save_after="$(docker exec inv-redis redis-cli --raw LASTSAVE)"
  last_status="$(docker exec inv-redis redis-cli --raw INFO persistence | tr -d '\r' | sed -n 's/^rdb_last_bgsave_status://p')"
  if [ "$in_progress" = "0" ] && \
    [ "$last_status" = "ok" ] && \
    [ "$last_save_after" -gt "$last_save_before" ]
  then
    snapshot_ready=true
    break
  fi
  sleep 1
done
if [ "$snapshot_ready" != "true" ]; then
  printf 'Redis BGSAVE did not produce a new snapshot: before=%s after=%s status=%s in_progress=%s\n' \
    "$last_save_before" "${last_save_after:-unknown}" "${last_status:-unknown}" \
    "${in_progress:-unknown}" >&2
  exit 1
fi
docker cp inv-redis:/data/dump.rdb "$backup_path.tmp"
mv "$backup_path.tmp" "$backup_path"
sha256sum "$backup_path" > "$backup_path.sha256"

if [ "${1:-}" = "--verify" ]; then
  drill_dir="$(mktemp -d)"
  drill_name="inv-redis-restore-drill-$timestamp"
  cleanup() {
    docker rm -f "$drill_name" >/dev/null 2>&1 || true
    rm -rf "$drill_dir"
  }
  trap cleanup EXIT
  cp "$backup_path" "$drill_dir/dump.rdb"
  docker run -d --name "$drill_name" -v "$drill_dir:/data" "$redis_image" \
    redis-stack-server --appendonly no >/dev/null
  restored=false
  for _attempt in $(seq 1 30); do
    if docker exec "$drill_name" redis-cli ping | grep -q PONG; then
      restored=true
      break
    fi
    sleep 1
  done
  [ "$restored" = "true" ] || {
    docker logs "$drill_name"
    echo "Redis restore drill failed" >&2
    exit 1
  }
  restored_dbsize="$(docker exec "$drill_name" redis-cli --raw DBSIZE)"
  if [ "$restored_dbsize" != "$source_dbsize" ]; then
    printf 'Redis restore drill DBSIZE mismatch: source=%s restored=%s\n' \
      "$source_dbsize" "$restored_dbsize" >&2
    exit 1
  fi
fi

printf '{"schema":"tradejs-redis-backup/v1","createdAt":"%s","dbSize":%s}\n' \
  "$timestamp" "$source_dbsize" > "$backup_path.meta.json"

find "$backup_root" -type f \( \
  -name 'dump-*.rdb' -o \
  -name 'dump-*.rdb.sha256' -o \
  -name 'dump-*.rdb.meta.json' \
\) \
  -mtime "+$retention_days" -delete
echo "$backup_path"
