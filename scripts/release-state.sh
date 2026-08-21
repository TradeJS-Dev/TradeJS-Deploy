#!/usr/bin/env bash

set -Eeuo pipefail

readonly release_state_file="${RELEASE_STATE_FILE:-release.env}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

validate_sha() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] ||
    fail "$label must be a full lowercase Git SHA"
}

reset_state() {
  APP_IMAGE_TAG=""
  PROJECT_SHA=""
  AGENT_IMAGE_TAG=""
  ML_INFER_IMAGE_TAG=""
  SITE_IMAGE_TAG=""
  DOCS_IMAGE_TAG=""
}

assign_once() {
  local key="$1"
  local value="$2"

  case "$key" in
    APP_IMAGE_TAG)
      [ -z "$APP_IMAGE_TAG" ] || fail "Duplicate release key: $key"
      APP_IMAGE_TAG="$value"
      ;;
    PROJECT_SHA)
      [ -z "$PROJECT_SHA" ] || fail "Duplicate release key: $key"
      PROJECT_SHA="$value"
      ;;
    AGENT_IMAGE_TAG)
      [ -z "$AGENT_IMAGE_TAG" ] || fail "Duplicate release key: $key"
      AGENT_IMAGE_TAG="$value"
      ;;
    ML_INFER_IMAGE_TAG)
      [ -z "$ML_INFER_IMAGE_TAG" ] || fail "Duplicate release key: $key"
      ML_INFER_IMAGE_TAG="$value"
      ;;
    SITE_IMAGE_TAG)
      [ -z "$SITE_IMAGE_TAG" ] || fail "Duplicate release key: $key"
      SITE_IMAGE_TAG="$value"
      ;;
    DOCS_IMAGE_TAG)
      [ -z "$DOCS_IMAGE_TAG" ] || fail "Duplicate release key: $key"
      DOCS_IMAGE_TAG="$value"
      ;;
    *) fail "Unknown release key: $key" ;;
  esac
}

validate_state() {
  validate_sha APP_IMAGE_TAG "$APP_IMAGE_TAG"
  validate_sha PROJECT_SHA "$PROJECT_SHA"
  validate_sha AGENT_IMAGE_TAG "$AGENT_IMAGE_TAG"
  validate_sha ML_INFER_IMAGE_TAG "$ML_INFER_IMAGE_TAG"
  validate_sha SITE_IMAGE_TAG "$SITE_IMAGE_TAG"
  validate_sha DOCS_IMAGE_TAG "$DOCS_IMAGE_TAG"
}

load_state() {
  [ -f "$release_state_file" ] || fail "Release state not found: $release_state_file"
  reset_state

  local line
  local key
  local value
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || fail "Release state contains an empty line"
    [[ "$line" == *=* ]] || fail "Invalid release state line: $line"
    key="${line%%=*}"
    value="${line#*=}"
    assign_once "$key" "$value"
  done < "$release_state_file"

  validate_state
}

write_state() {
  validate_state
  local temporary_file="${release_state_file}.tmp.$$"
  umask 077
  {
    printf 'APP_IMAGE_TAG=%s\n' "$APP_IMAGE_TAG"
    printf 'PROJECT_SHA=%s\n' "$PROJECT_SHA"
    printf 'AGENT_IMAGE_TAG=%s\n' "$AGENT_IMAGE_TAG"
    printf 'ML_INFER_IMAGE_TAG=%s\n' "$ML_INFER_IMAGE_TAG"
    printf 'SITE_IMAGE_TAG=%s\n' "$SITE_IMAGE_TAG"
    printf 'DOCS_IMAGE_TAG=%s\n' "$DOCS_IMAGE_TAG"
  } > "$temporary_file"
  chmod 0644 "$temporary_file"
  mv "$temporary_file" "$release_state_file"
}

initialize_state() {
  [ "$#" -eq 6 ] ||
    fail "Usage: release-state.sh initialize <app-sha> <project-sha> <agent-sha> <ml-sha> <site-sha> <docs-sha>"
  APP_IMAGE_TAG="$1"
  PROJECT_SHA="$2"
  AGENT_IMAGE_TAG="$3"
  ML_INFER_IMAGE_TAG="$4"
  SITE_IMAGE_TAG="$5"
  DOCS_IMAGE_TAG="$6"
  write_state
}

update_state() {
  local component="${1:-}"
  local image_sha="${2:-}"
  load_state
  validate_sha image_sha "$image_sha"

  case "$component" in
    app)
      [ "$#" -eq 3 ] ||
        fail "Updating app requires its matching Project SHA"
      validate_sha project_sha "$3"
      APP_IMAGE_TAG="$image_sha"
      PROJECT_SHA="$3"
      ;;
    agent)
      [ "$#" -eq 2 ] || fail "Agent update accepts one image SHA"
      AGENT_IMAGE_TAG="$image_sha"
      ;;
    ml-infer)
      [ "$#" -eq 2 ] || fail "ML update accepts one image SHA"
      ML_INFER_IMAGE_TAG="$image_sha"
      ;;
    site)
      [ "$#" -eq 2 ] || fail "Site update accepts one image SHA"
      SITE_IMAGE_TAG="$image_sha"
      ;;
    docs)
      [ "$#" -eq 2 ] || fail "Docs update accepts one image SHA"
      DOCS_IMAGE_TAG="$image_sha"
      ;;
    *) fail "Unsupported release component: $component" ;;
  esac

  write_state
}

print_value() {
  [ "$#" -eq 1 ] || fail "Usage: release-state.sh value <component>"
  load_state
  case "$1" in
    app) printf '%s\n' "$APP_IMAGE_TAG" ;;
    project) printf '%s\n' "$PROJECT_SHA" ;;
    agent) printf '%s\n' "$AGENT_IMAGE_TAG" ;;
    ml-infer) printf '%s\n' "$ML_INFER_IMAGE_TAG" ;;
    site) printf '%s\n' "$SITE_IMAGE_TAG" ;;
    docs) printf '%s\n' "$DOCS_IMAGE_TAG" ;;
    *) fail "Unsupported release component: $1" ;;
  esac
}

command="${1:-}"
shift || true
case "$command" in
  initialize) initialize_state "$@" ;;
  update) update_state "$@" ;;
  validate)
    [ "$#" -eq 0 ] || fail "validate accepts no arguments"
    load_state
    ;;
  value) print_value "$@" ;;
  *) fail "Usage: release-state.sh initialize|update|validate|value ..." ;;
esac
