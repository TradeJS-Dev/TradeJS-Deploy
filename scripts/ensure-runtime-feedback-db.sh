#!/usr/bin/env bash

set -Eeuo pipefail

readonly replay_role="runtime_replay"
readonly database="${REPLAY_PG_DATABASE:-app}"
readonly env_file="${RUNTIME_FEEDBACK_ENV_FILE:-$HOME/.runtime-feedback.env}"
readonly network="${RUNTIME_FEEDBACK_NETWORK:-tradejs-runtime-replay}"

replay_pg_password="${REPLAY_PG_PASSWORD:-}"
if [ -z "$replay_pg_password" ]; then
  if [ -z "${PG_PASSWORD:-}" ]; then
    echo "PG_PASSWORD is required when REPLAY_PG_PASSWORD is not set" >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    password_digest="$(
      printf 'tradejs-runtime-replay-password/v1\0%s' "$PG_PASSWORD" |
        sha256sum | awk '{print $1}'
    )"
  else
    password_digest="$(
      printf 'tradejs-runtime-replay-password/v1\0%s' "$PG_PASSWORD" |
        shasum -a 256 | awk '{print $1}'
    )"
  fi
  replay_pg_password="tradejs_replay_$password_digest"
  unset password_digest
fi
docker inspect inv-timescale >/dev/null

escaped_password="$(printf '%s' "$replay_pg_password" | sed "s/'/''/g")"
printf "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %s LOGIN; END IF; END \$\$;\nALTER ROLE %s WITH LOGIN PASSWORD '%s';\nALTER ROLE %s SET default_transaction_read_only = on;\nGRANT CONNECT ON DATABASE %s TO %s;\nGRANT USAGE ON SCHEMA public TO %s;\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO %s;\nGRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO %s;\nALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA public GRANT SELECT ON TABLES TO %s;\nALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA public GRANT SELECT ON SEQUENCES TO %s;\n" \
  "$replay_role" "$replay_role" "$replay_role" "$escaped_password" \
  "$replay_role" "$database" "$replay_role" "$replay_role" \
  "$replay_role" "$replay_role" "$replay_role" "$replay_role" |
  docker exec -i inv-timescale psql -v ON_ERROR_STOP=1 -U app -d "$database"
unset escaped_password

docker network inspect "$network" >/dev/null 2>&1 ||
  docker network create --internal "$network" >/dev/null
if ! docker inspect --format '{{json .NetworkSettings.Networks}}' inv-timescale |
  grep -q "\"$network\""; then
  docker network connect --alias timescale "$network" inv-timescale
fi
if docker inspect ml-infer >/dev/null 2>&1 &&
  ! docker inspect --format '{{json .NetworkSettings.Networks}}' ml-infer |
    grep -q "\"$network\""; then
  docker network connect --alias ml-infer "$network" ml-infer
fi

env_dir="$(dirname "$env_file")"
mkdir -p "$env_dir"
temporary_file="$(mktemp "$env_dir/.runtime-feedback-env.XXXXXX")"
cleanup() {
  rm -f "$temporary_file"
}
trap cleanup EXIT
umask 077
{
  printf 'PG_USER=%s\n' "$replay_role"
  printf 'PG_PASSWORD=%s\n' "$replay_pg_password"
  printf 'PG_DATABASE=%s\n' "$database"
} > "$temporary_file"
chmod 600 "$temporary_file"
mv "$temporary_file" "$env_file"
trap - EXIT

echo "Runtime feedback database reader and isolated network are ready."
