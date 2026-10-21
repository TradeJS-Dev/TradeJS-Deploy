#!/usr/bin/env bash
set -Eeuo pipefail
cd "${DEPLOY_ROOT:-$HOME}"
mode="${1:-observe}"
[[ "$mode" = deploy || "$mode" = observe ]] || exit 1
# Serialize collectors with each other; deployment already serializes its rollout.
mkdir -p data
exec 9>data/.runtime-verification.lock
if [ "$mode" = deploy ]; then flock -w 60 9; else flock -n 9 || exit 0; fi
image_id="$(docker inspect --format '{{.Image}}' app)"
# The app tag is also its exact Project SHA.
project_sha="$(sed -n 's/^APP_IMAGE_TAG=//p' release.env | tail -n 1)"
[[ "$project_sha" =~ ^[a-f0-9]{40}$ ]] || exit 1
expected_id="$(docker image inspect --format '{{.Id}}' "ghcr.io/tradejs-dev/tradejs-project-app:$project_sha")"
[[ "$image_id" = "$expected_id" ]] || { echo 'App image differs from release' >&2; exit 1; }
digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" | sed -n 's#^ghcr.io/tradejs-dev/tradejs-project-app@##p' | head -n 1)"
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
mkdir -p data/runtime-verification
work="$(mktemp -d data/runtime-verification/.capture.XXXXXX)"
trap 'rm -rf -- "$work"' EXIT
docker cp app:/app/runtime-package-manifest.json "$work/manifest.json" >/dev/null
docker inspect --format '{"health":"{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}","startedAt":"{{.State.StartedAt}}","restartCount":{{.RestartCount}},"imageDigest":"'"$digest"'"}' app > "$work/container.json"
# Read the app's actual declared daemon targets without exporting its environment.
targets="$(docker exec app printenv SIGNALS_DAEMON_DEPLOYMENT_ID)"
IFS=',' read -r -a deployments <<<"$targets"
status=0
record_attempt() {
  local target_dir="data/runtime-verification/root/$deployment"
  mkdir -p "$target_dir"
  local temporary
  temporary="$(mktemp "$target_dir/.attempt.XXXXXX")"
  printf '{"projectSha":"%s","imageDigest":"%s","observedAt":%s000,"status":"%s"}\n' "$project_sha" "$digest" "$(date +%s)" "$1" > "$temporary"
  mv "$temporary" "$target_dir/latest-attempt.json"
}
for deployment in "${deployments[@]}"; do
  [[ "$deployment" =~ ^[a-zA-Z0-9_-]+$ ]] || { status=1; continue; }
  record_attempt running
  docker exec app ./node_modules/.bin/tradejs runtime-control verify --user root --deployment "$deployment" > "$work/verify.json" || { record_attempt failed; status=1; continue; }
  # A recreated app must not inherit the previous container's observation.
  [[ "$(docker inspect --format '{{.Image}}:{{.State.StartedAt}}' app)" = "$image_id:$(sed -n 's/.*"startedAt":"\([^"]*\)".*/\1/p' "$work/container.json")" ]] || exit 1
  docker run --rm --entrypoint node -v "$PWD:/deploy" "$image_id" /deploy/scripts/write-runtime-verification.mjs /deploy/data/runtime-verification "/deploy/$work/manifest.json" "/deploy/$work/verify.json" "/deploy/$work/container.json" "$mode" || { record_attempt failed; status=1; continue; }
  record_attempt succeeded
done
exit "$status"
