#!/usr/bin/env bash
set -euo pipefail

backup_root="${REDIS_BACKUP_DIR:-$HOME/backups/redis}"
retention_days="${REDIS_BACKUP_RETENTION_DAYS:-14}"
redis_image="redis/redis-stack:7.4.0-v8"
redis_container="${REDIS_CONTAINER:-inv-redis}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="$backup_root/dump-$timestamp.rdb"
persistent_count_script="local cursor='0'; local count=0; repeat local result=redis.call('SCAN', cursor, 'COUNT', 1000); cursor=result[1]; for _, key in ipairs(result[2]) do if redis.call('PTTL', key) == -1 then count=count+1 end end until cursor == '0'; return count"
verify=false
prepare_volume=false

for argument in "$@"; do
  case "$argument" in
    --verify)
      verify=true
      ;;
    --prepare-volume)
      prepare_volume=true
      ;;
    *)
      printf 'Unsupported redis-backup argument: %s\n' "$argument" >&2
      exit 1
      ;;
  esac
done
if [ "$prepare_volume" = true ] && [ "$verify" != true ]; then
  echo '--prepare-volume requires --verify' >&2
  exit 1
fi
if [[ ! "$redis_container" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  printf 'Invalid Redis container name: %s\n' "$redis_container" >&2
  exit 1
fi

mkdir -p "$backup_root"
source_dir="$(
  docker exec "$redis_container" redis-cli --raw CONFIG GET dir | sed -n '2p'
)"
source_dbfilename="$(
  docker exec "$redis_container" redis-cli --raw CONFIG GET dbfilename | sed -n '2p'
)"
if [[ ! "$source_dir" =~ ^/[A-Za-z0-9_./-]+$ ]]; then
  printf 'Invalid Redis persistence directory: %s\n' "$source_dir" >&2
  exit 1
fi
if [[ ! "$source_dbfilename" =~ ^[A-Za-z0-9._-]+$ ]]; then
  printf 'Invalid Redis RDB filename: %s\n' "$source_dbfilename" >&2
  exit 1
fi
source_dbsize="$(docker exec "$redis_container" redis-cli --raw DBSIZE)"
source_persistent_keys="$(
  docker exec "$redis_container" redis-cli --raw EVAL "$persistent_count_script" 0
)"
snapshot_dbsize="$source_dbsize"
snapshot_persistent_keys="$source_persistent_keys"
last_save_before="$(docker exec "$redis_container" redis-cli --raw LASTSAVE)"
while [ "$(date +%s)" -le "$last_save_before" ]; do
  sleep 1
done
docker exec "$redis_container" redis-cli BGSAVE >/dev/null
snapshot_ready=false
for _attempt in $(seq 1 120); do
  in_progress="$(docker exec "$redis_container" redis-cli --raw INFO persistence | tr -d '\r' | sed -n 's/^rdb_bgsave_in_progress://p')"
  last_save_after="$(docker exec "$redis_container" redis-cli --raw LASTSAVE)"
  last_status="$(docker exec "$redis_container" redis-cli --raw INFO persistence | tr -d '\r' | sed -n 's/^rdb_last_bgsave_status://p')"
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
docker cp "$redis_container:$source_dir/$source_dbfilename" "$backup_path.tmp"
mv "$backup_path.tmp" "$backup_path"
sha256sum "$backup_path" > "$backup_path.sha256"
docker run --rm --user 0 --entrypoint redis-check-rdb \
  -v "$backup_root:/backup:ro" \
  "$redis_image" "/backup/$(basename "$backup_path")" >/dev/null

if [ "$verify" = true ]; then
  drill_name="inv-redis-restore-drill-$timestamp"
  cleanup() {
    docker rm -f "$drill_name" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT
  docker run -d --name "$drill_name" --user 0 \
    -v "$backup_path:/data/dump.rdb:ro" "$redis_image" \
    redis-stack-server --dir /data --dbfilename dump.rdb \
    --appendonly no >/dev/null
  restored=false
  for _attempt in $(seq 1 "${REDIS_RESTORE_WAIT_ATTEMPTS:-300}"); do
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
  restored_persistent_keys="$(
    docker exec "$drill_name" redis-cli --raw EVAL "$persistent_count_script" 0
  )"
  snapshot_dbsize="$restored_dbsize"
  snapshot_persistent_keys="$restored_persistent_keys"
  if [ "$source_persistent_keys" -gt 0 ] && \
    [ "$restored_persistent_keys" -eq 0 ]
  then
    printf 'Redis restore drill loaded no persistent keys from a non-empty source: source=%s (DBSIZE source=%s restored=%s)\n' \
      "$source_persistent_keys" "$source_dbsize" "$restored_dbsize" >&2
    exit 1
  fi
  if [ "$restored_persistent_keys" != "$source_persistent_keys" ]; then
    printf 'Redis snapshot/live persistent-key drift: source=%s restored=%s (DBSIZE source=%s restored=%s)\n' \
      "$source_persistent_keys" "$restored_persistent_keys" \
      "$source_dbsize" "$restored_dbsize" >&2
  fi
fi

if [ "$prepare_volume" = true ] && [ "$source_dir" != /data ]; then
  volume_source="$(
    docker inspect --format='{{range .Mounts}}{{if eq .Destination "/data"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' \
      "$redis_container"
  )"
  "$script_dir/redis-volume-restore.sh" \
    "$backup_path" "$volume_source" "$snapshot_persistent_keys" pre-canonical \
    >&2
fi

printf '{"schema":"tradejs-redis-backup/v1","createdAt":"%s","dbSize":%s,"persistentKeyCount":%s,"sourceDir":"%s","sourceDbfilename":"%s"}\n' \
  "$timestamp" "$snapshot_dbsize" "$snapshot_persistent_keys" \
  "$source_dir" "$source_dbfilename" \
  > "$backup_path.meta.json"

find "$backup_root" -type f \( \
  -name 'dump-*.rdb' -o \
  -name 'dump-*.rdb.sha256' -o \
  -name 'dump-*.rdb.meta.json' \
\) \
  -mtime "+$retention_days" -delete
echo "$backup_path"
