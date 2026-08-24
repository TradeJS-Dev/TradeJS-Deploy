#!/usr/bin/env bash

set -Eeuo pipefail

env_file="${1:-}"
image_ref="${2:-}"
if [ -z "$env_file" ] || [ -z "$image_ref" ]; then
  echo "Usage: $0 <runtime-env-file> <image-ref>" >&2
  exit 1
fi
if [ ! -f "$env_file" ]; then
  echo "Runtime environment file not found: $env_file" >&2
  exit 1
fi

image_repository="${image_ref%:*}"
image_digest="$({
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_ref"
} | sed -n "s#^${image_repository}@##p" | head -n 1)"
if [[ ! "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Cannot resolve immutable digest for $image_ref" >&2
  exit 1
fi

env_dir="$(cd "$(dirname "$env_file")" && pwd)"
temporary_file="$(mktemp "$env_dir/.runtime-env.XXXXXX")"
cleanup() {
  rm -f "$temporary_file"
}
trap cleanup EXIT

grep -v '^TRADEJS_PROJECT_IMAGE_DIGEST=' "$env_file" > "$temporary_file"
printf 'TRADEJS_PROJECT_IMAGE_DIGEST=%s\n' "$image_digest" >> "$temporary_file"
chmod 600 "$temporary_file"
mv "$temporary_file" "$env_file"
trap - EXIT

printf '%s\n' "$image_digest"
