#!/usr/bin/env bash
set -Eeuo pipefail

apply=false
user_name=""
redis_container="inv-redis"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      apply=true
      shift
      ;;
    --user)
      user_name="${2:-}"
      shift 2
      ;;
    --redis-container)
      redis_container="${2:-}"
      shift 2
      ;;
    *)
      printf 'Unsupported argument: %s\n' "$1" >&2
      exit 1
      ;;
  esac
done

if [[ ! "$user_name" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo 'A safe --user identifier is required' >&2
  exit 1
fi
if [[ ! "$redis_container" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo 'Invalid Redis container name' >&2
  exit 1
fi

declare -a candidates=()
while IFS= read -r key; do
  [ -n "$key" ] && candidates+=("$key")
done < <(
  docker exec "$redis_container" redis-cli --scan \
    --pattern "users:$user_name:strategies*"
)

deployment_prefix="users:$user_name:runtime:deployments:"
while IFS= read -r key; do
  [ -n "$key" ] || continue
  suffix="${key#"$deployment_prefix"}"
  if [ -n "$suffix" ] && [[ "$suffix" != *:* ]]; then
    candidates+=("$key")
  fi
done < <(
  docker exec "$redis_container" redis-cli --scan \
    --pattern "${deployment_prefix}*"
)

sorted_candidates="$(printf '%s\n' "${candidates[@]}" | sed '/^$/d' | sort -u)"
candidates=()
while IFS= read -r key; do
  [ -n "$key" ] && candidates+=("$key")
done <<< "$sorted_candidates"
printf 'Legacy runtime Redis candidates: %s\n' "${#candidates[@]}"
for key in "${candidates[@]}"; do
  case "$key" in
    "users:$user_name:strategies" | "users:$user_name:strategies:"*)
      ;;
    "users:$user_name:runtime:deployments:"*)
      suffix="${key#"$deployment_prefix"}"
      [ -n "$suffix" ] && [[ "$suffix" != *:* ]] || {
        printf 'Refusing unexpected deployment key: %s\n' "$key" >&2
        exit 1
      }
      ;;
    *)
      printf 'Refusing non-legacy key: %s\n' "$key" >&2
      exit 1
      ;;
  esac
  printf '%s [%s]\n' "$key" \
    "$(docker exec "$redis_container" redis-cli --raw TYPE "$key")"
done

if [ "$apply" != true ]; then
  echo 'Dry run only; no keys deleted.'
  exit 0
fi
if [ "${TRADEJS_CONFIRM_LEGACY_RUNTIME_CLEANUP:-}" != DELETE_LEGACY_RUNTIME_KEYS ]; then
  echo 'Explicit legacy cleanup confirmation is required' >&2
  exit 1
fi

for key in "${candidates[@]}"; do
  docker exec "$redis_container" redis-cli --raw UNLINK "$key" >/dev/null
done

echo "Deleted ${#candidates[@]} allowlisted legacy runtime Redis keys."
