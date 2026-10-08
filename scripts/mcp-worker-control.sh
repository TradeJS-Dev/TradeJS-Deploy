#!/usr/bin/env bash
set -Eeuo pipefail

cd "${DEPLOY_ROOT:-$HOME}"
readonly release_file="${RELEASE_ENV_FILE:-release.env}"
readonly mode="${1:-reconcile}"
case "$mode" in stop|reconcile) ;; *) echo "Use stop or reconcile" >&2; exit 1 ;; esac
export APP_IMAGE_TAG="$(sed -n 's/^APP_IMAGE_TAG=//p' "$release_file" | tail -n 1)"
[[ "$APP_IMAGE_TAG" =~ ^[0-9a-f]{40}$ ]] || { echo "MCP worker requires the release's exact app SHA" >&2; exit 1; }
compose=(docker compose --env-file .env --env-file "$release_file" -f docker-compose.prod.yml --profile mcp)
if [ "$mode" = stop ]; then
  "${compose[@]}" stop -t 15 mcp-worker
  exit 0
fi
enabled="$(sed -n 's/^MCP_WORKER_ENABLED=//p' .env | tail -n 1)"
case "$enabled" in
  ''|false) "${compose[@]}" stop -t 15 mcp-worker mcp-replay-redis; exit 0 ;;
  true) ;;
  *) echo "MCP_WORKER_ENABLED must be true or false" >&2; exit 1 ;;
esac
"${compose[@]}" pull mcp-worker mcp-replay-redis
"${compose[@]}" up -d --wait --wait-timeout 60 mcp-replay-redis
"${compose[@]}" up -d --no-deps --force-recreate mcp-worker
for attempt in $(seq 1 30); do
  if docker exec app node --input-type=module --eval '
    import fs from "node:fs/promises";
    import { createHash } from "node:crypto";
    import { mcpStorage, closeRedisConnection } from "@tradejs/infra/redis";
    try {
      const heartbeat = await mcpStorage.get("worker:heartbeat");
      const manifest = await fs.readFile("/app/runtime-package-manifest.json");
      const hash = createHash("sha256").update(manifest).digest("hex");
      if (!heartbeat || Date.now() - heartbeat.observedAt > 15000 || heartbeat.packageManifestSha256 !== hash) process.exitCode = 1;
    } finally { await closeRedisConnection(); }
  '; then exit 0; fi
  sleep 1
done
echo "MCP worker did not become ready with the app package composition" >&2
exit 1
