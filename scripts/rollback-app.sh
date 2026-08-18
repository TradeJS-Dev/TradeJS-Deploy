#!/usr/bin/env bash

set -Eeuo pipefail

readonly deploy_root="${DEPLOY_ROOT:-$HOME}"
readonly release_env_file="${RELEASE_ENV_FILE:-release.env}"
cd "$deploy_root"

if [ ! -f "$release_env_file" ]; then
  echo "Rollback release env not found: $release_env_file" >&2
  exit 1
fi

rollback_app_image_tag="$({
  sed -n 's/^APP_IMAGE_TAG=//p' "$release_env_file" || true
} | tail -n 1)"
if [[ ! "$rollback_app_image_tag" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Rollback APP_IMAGE_TAG must be a full commit SHA" >&2
  exit 1
fi

APP_IMAGE_TAG="$rollback_app_image_tag" docker compose \
  --env-file .env \
  --env-file "$release_env_file" \
  -f docker-compose.prod.yml \
  up -d --no-deps --force-recreate app
