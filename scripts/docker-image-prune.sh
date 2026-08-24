#!/usr/bin/env bash

set -Eeuo pipefail

now="$(date +%s)"
while IFS= read -r container; do
  [ -n "$container" ] || continue
  expires_at="$(docker inspect --format '{{index .Config.Labels "tradejs.runtime-feedback.expires-at"}}' "$container")"
  if [[ "$expires_at" =~ ^[0-9]+$ ]] && [ "$expires_at" -le "$now" ]; then
    docker rm "$container" >/dev/null
    echo "Removed expired runtime feedback image lease: $container"
  fi
done < <(docker ps -aq --filter label=tradejs.runtime-feedback.image-lease=true)

# Unexpired lease containers intentionally remain stopped: Docker keeps every
# image referenced by a container when pruning dangling/unused images.
docker image prune -a -f
